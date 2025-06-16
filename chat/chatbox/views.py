# chatbox/views.py
import json
import redis
from django.conf import settings
from django_redis import get_redis_connection
from channels.layers import get_channel_layer
from asgiref.sync import async_to_sync

from rest_framework import generics, permissions, status
from rest_framework.response import Response
from rest_framework.pagination import PageNumberPagination
from .models import ChatMessage, User
from .serializers import ChatMessageSerializer
from django.db.models import Q

class ChatMessageListCreateView(generics.ListCreateAPIView):
    serializer_class = ChatMessageSerializer
    permission_classes = [permissions.IsAuthenticated]
    pagination_class = PageNumberPagination

    # The original get_queryset logic is now a helper method.
    def _get_messages_from_db(self, user, room_name=None, receiver_id=None):
        """
        This is the COLD PATH: Fetches messages directly from the database.
        """
        is_dm = receiver_id is not None

        if is_dm:
            try:
               
                int(receiver_id) 
            except (ValueError, TypeError):
                
                return ChatMessage.objects.none()
            
        if room_name and not is_dm:
            return ChatMessage.objects.filter(room_name=room_name).order_by('-timestamp')
        elif is_dm and receiver_id:
            return ChatMessage.objects.filter(
                Q(sender=user, receiver_id=receiver_id, is_dm=True) |
                Q(sender_id=receiver_id, receiver=user, is_dm=True)
            ).order_by('-timestamp')
        return ChatMessage.objects.none()

  

    def list(self, request, *args, **kwargs):
            # --- NEW: Check if we are in sync_receipts mode ---
            is_sync_mode = request.query_params.get('sync_receipts')

            if is_sync_mode:
                # --- NEW: Handle the sync logic ---
                conversation_id = request.query_params.get('conversation_id')
                if not conversation_id:
                    return Response(
                        {"detail": "conversation_id parameter is required for sync."},
                        status=status.HTTP_400_BAD_REQUEST
                    )
                
                read_messages_ids = ChatMessage.objects.filter(
                    room_name=conversation_id,
                    sender=request.user,
                    is_read=True
                ).values_list('id', flat=True)

                return Response({'read_message_ids': list(read_messages_ids)})

            # --- ORIGINAL: The existing logic for fetching message history ---
            else:
                user = request.user
                room_name = request.query_params.get('room_name')
                receiver_id = request.query_params.get('receiver_id')

                if room_name:
                    cache_key = f'chat_history:{room_name}'
                elif receiver_id:
                    try:
                        int(receiver_id)
                        user_ids = sorted([str(user.id), str(receiver_id)])
                        dm_room_name = f'dm_{"_".join(user_ids)}'
                        cache_key = f'chat_history:{dm_room_name}'
                    except (ValueError, TypeError):
                        return Response({"detail": "Invalid receiver_id."}, status=status.HTTP_400_BAD_REQUEST)
                else:
                    return Response({"results": []})

                redis_url = settings.CHANNEL_LAYERS['default']['CONFIG']['hosts'][0]
                redis_conn = redis.from_url(redis_url, decode_responses=True)

                # --- HOT PATH ---
                cached_messages = redis_conn.lrange(cache_key, 0, -1)
                if cached_messages:
                    print(f"API CACHE HIT for {cache_key}")
                    data = [json.loads(msg) for msg in reversed(cached_messages)]
                    
                    page = self.paginate_queryset(data)
                    if page is not None:
                        return self.get_paginated_response(page)
                    
                    return Response(data)

                # --- COLD PATH ---
                print(f"API CACHE MISS for {cache_key}. Fetching from DB.")
                queryset = self._get_messages_from_db(user, room_name, receiver_id)
                
                page = self.paginate_queryset(queryset)
                if page is not None:
                    serializer = self.get_serializer(page, many=True)
                    
                    if serializer.data:
                        pipeline = redis_conn.pipeline()
                        pipeline.delete(cache_key)
                        for message in reversed(serializer.data):
                            pipeline.lpush(cache_key, json.dumps(message))
                        pipeline.ltrim(cache_key, 0, 49)
                        pipeline.execute()
                        
                    return self.get_paginated_response(serializer.data)

                serializer = self.get_serializer(queryset, many=True)
                return Response(serializer.data)

    def perform_create(self, serializer):
        """
        Handles POST requests to create a new message.
        Writes to both the COLD (DB) and HOT (Cache) paths, and broadcasts.
        """
        sender = self.request.user
        is_dm = self.request.data.get('is_dm', False)
        room_name = self.request.data.get('room_name')
        receiver_id = self.request.data.get('receiver')

        receiver_instance = None
        if is_dm and receiver_id:
            try:
                receiver_instance = User.objects.get(id=receiver_id)
                # For DMs, create a consistent room name for caching and broadcasting
                user_ids = sorted([str(sender.id), str(receiver_id)])
                room_name = f'dm_{"_".join(user_ids)}'
            except User.DoesNotExist:
                raise generics.ValidationError("Receiver user not found.")
        
        if not room_name:
            raise generics.ValidationError("Room name or receiver is required.")

        
        instance = serializer.save(sender=sender, room_name=room_name, receiver=receiver_instance, is_dm=is_dm)

        message_data = ChatMessageSerializer(instance).data
        redis_conn = get_redis_connection("default")
        cache_key = f'chat_history:{room_name}'
        
        redis_conn.lpush(cache_key, json.dumps(message_data))
        redis_conn.ltrim(cache_key, 0, 49)

        
        channel_layer = get_channel_layer()
        broadcast_group_name = f'chat_{room_name}'
        
        async_to_sync(channel_layer.group_send)(
            broadcast_group_name,
            {
                'type': 'chat.message.broadcast',
                **message_data # Send the full serialized message data
            }
        )