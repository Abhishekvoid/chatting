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
from rest_framework.views import APIView
import logging

logger = logging.getLogger(__name__)

class ChatMessageListCreateView(generics.ListCreateAPIView):
    serializer_class = ChatMessageSerializer
    permission_classes = [permissions.IsAuthenticated]
    pagination_class = PageNumberPagination

    def generate_cache_key(self, room_name):
        """Generate consistent cache key."""
        return f'chat_history:{room_name}'

    def _get_messages_from_db(self, user, room_name=None, receiver_id=None):
        """
        COLD PATH: Fetches messages directly from the database.
        """
        is_dm = receiver_id is not None

        if is_dm:
            try:
                int(receiver_id) 
            except (ValueError, TypeError):
                logger.error(f"Invalid receiver_id: {receiver_id}")
                return ChatMessage.objects.none()
            
        if room_name and not is_dm:
            return ChatMessage.objects.filter(room_name=room_name).order_by('-timestamp')
        elif is_dm and receiver_id:
            return ChatMessage.objects.filter(
                Q(sender=user, receiver_id=receiver_id, is_dm=True) |
                Q(sender_id=receiver_id, receiver=user, is_dm=True)
            ).order_by('-timestamp')
        return ChatMessage.objects.none()

    def get_redis_connection_safe(self):
        """Get Redis connection with error handling."""
        try:
            redis_url = settings.CHANNEL_LAYERS['default']['CONFIG']['hosts'][0]
            return redis.from_url(redis_url, decode_responses=True)
        except Exception as e:
            logger.error(f"Failed to connect to Redis: {e}")
            return None

    def list(self, request, *args, **kwargs):
        user = request.user
        room_name = request.query_params.get('room_name')
        receiver_id = request.query_params.get('receiver_id')

        # --- This view no longer handles sync_receipts for simplicity ---
        # The primary function is fetching message history.

        # Directly fetch from the database (the "cold path" is now the only path)
        logger.info(f"Bypassing cache, fetching history directly from DB for user {user.id}")
        
        try:
            # Get the base queryset
            queryset = self._get_messages_from_db(user, room_name, receiver_id)
            
            # Paginate the queryset
            page = self.paginate_queryset(queryset)
            if page is not None:
                serializer = self.get_serializer(page, many=True)
                return self.get_paginated_response(serializer.data)

            # This fallback should ideally not be reached if pagination is configured
            serializer = self.get_serializer(queryset, many=True)
            return Response(serializer.data)
            
        except Exception as e:
            logger.error(f"Error fetching messages from database: {e}")
            return Response(
                {"detail": "Error fetching messages."},
                status=status.HTTP_500_INTERNAL_SERVER_ERROR
            )

        # --- Handle normal message history fetching ---
        user = request.user
        room_name = request.query_params.get('room_name')
        receiver_id = request.query_params.get('receiver_id')

        # Determine cache key
        if room_name:
            cache_key = self.generate_cache_key(room_name)
        elif receiver_id:
            try:
                int(receiver_id)
                user_ids = sorted([str(user.id), str(receiver_id)])
                dm_room_name = f'dm_{"_".join(user_ids)}'
                cache_key = self.generate_cache_key(dm_room_name)
            except (ValueError, TypeError):
                return Response(
                    {"detail": "Invalid receiver_id."}, 
                    status=status.HTTP_400_BAD_REQUEST
                )
        else:
            return Response({"results": []})

        # Try to get Redis connection
        redis_conn = self.get_redis_connection_safe()
        
        if redis_conn:
            try:
                # --- HOT PATH: Try cache first ---
                cached_messages = redis_conn.lrange(cache_key, 0, -1)
                if cached_messages:
                    logger.info(f"API CACHE HIT for {cache_key}")
                    # Reverse because we store newest first in cache
                    data = [json.loads(msg) for msg in reversed(cached_messages)]
                    
                    page = self.paginate_queryset(data)
                    if page is not None:
                        return self.get_paginated_response(page)
                    
                    return Response(data)
            except Exception as e:
                logger.error(f"Error reading from cache: {e}")
                # Fall through to database query

        # --- COLD PATH: Cache miss or Redis unavailable ---
        logger.info(f"API CACHE MISS for {cache_key}. Fetching from DB.")
        
        try:
            queryset = self._get_messages_from_db(user, room_name, receiver_id)
            
            page = self.paginate_queryset(queryset)
            if page is not None:
                serializer = self.get_serializer(page, many=True)
                
                # Update cache if Redis is available and we have data
                if redis_conn and serializer.data:
                    try:
                        pipeline = redis_conn.pipeline()
                        pipeline.delete(cache_key)
                        # Store messages in reverse order (newest first)
                        for message in reversed(serializer.data):
                            pipeline.lpush(cache_key, json.dumps(message))
                        pipeline.ltrim(cache_key, 0, 49)  # Keep last 50 messages
                        pipeline.execute()
                        logger.info(f"Cache updated for {cache_key}")
                    except Exception as e:
                        logger.error(f"Error updating cache: {e}")
                        
                return self.get_paginated_response(serializer.data)

            serializer = self.get_serializer(queryset, many=True)
            return Response(serializer.data)
            
        except Exception as e:
            logger.error(f"Error fetching messages from database: {e}")
            return Response(
                {"detail": "Error fetching messages."},
                status=status.HTTP_500_INTERNAL_SERVER_ERROR
            )

    def perform_create(self, serializer):
        """
        Handles POST requests. Saves the message and updates the cache.
        """
        try:
            sender = self.request.user
            is_dm = self.request.data.get('is_dm', False)
            room_name = self.request.data.get('room_name')
            receiver_id = self.request.data.get('receiver')

            receiver_instance = None
            if is_dm and receiver_id:
                try:
                    receiver_instance = User.objects.get(id=receiver_id)
                    user_ids = sorted([str(sender.id), str(receiver_id)])
                    room_name = f'dm_{"_".join(user_ids)}'
                except User.DoesNotExist:
                    raise generics.ValidationError("Receiver user not found.")
            
            if not room_name:
                raise generics.ValidationError("Room name or receiver is required.")

            # Save the message
            instance = serializer.save(
                sender=sender, 
                room_name=room_name, 
                receiver=receiver_instance, 
                is_dm=is_dm
            )

            # Update the cache
            message_data = ChatMessageSerializer(instance).data
            cache_key = self.generate_cache_key(room_name)
            
            redis_conn = self.get_redis_connection_safe()
            if redis_conn:
                try:
                    # Add to front of cache (newest first)
                    redis_conn.lpush(cache_key, json.dumps(message_data))
                    redis_conn.ltrim(cache_key, 0, 49)  # Keep last 50 messages
                    logger.info(f"Cache updated for {cache_key} (API)")
                except Exception as e:
                    logger.error(f"Error updating cache in perform_create: {e}")
            
        except Exception as e:
            logger.error(f"Error in perform_create: {e}")
            raise


class UserChatListView(APIView):
    """
    This view fetches the initial list of a user's conversations.
    - DMs: A list of unique users they have messaged.
    - Rooms: A list of unique public rooms they have joined.
    """
    permission_classes = [permissions.IsAuthenticated]

    def get(self, request, *args, **kwargs):
        try:
            user = request.user
            
            # Find all unique users the current user has had a DM with
            sent_to_users = User.objects.filter(
                received_messages__sender=user, 
                received_messages__is_dm=True
            )
            received_from_users = User.objects.filter(
                sent_messages__receiver=user, 
                sent_messages__is_dm=True
            )
            # Combine and get unique users
            dm_partners = (sent_to_users | received_from_users).distinct()

            # Find all unique public room names the user has participated in
            rooms = ChatMessage.objects.filter(
                sender=user, 
                is_dm=False
            ).values_list('room_name', flat=True).distinct()

            # Use the UserSerializer to format the DM partner data correctly
            from .serializers import UserSerializer 
            dm_serializer = UserSerializer(dm_partners, many=True)
            
            return Response({
                'dms': dm_serializer.data, 
                'rooms': list(rooms)
            })
            
        except Exception as e:
            logger.error(f"Error in UserChatListView: {e}")
            return Response(
                {"detail": "Error fetching chat list."},
                status=status.HTTP_500_INTERNAL_SERVER_ERROR
            )