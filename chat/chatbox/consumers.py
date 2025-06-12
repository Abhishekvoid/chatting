# chatbox/consumers.py

import json
import redis.asyncio as async_redis
from django.conf import settings
from channels.generic.websocket import AsyncWebsocketConsumer
from channels.db import database_sync_to_async
from django.contrib.auth import get_user_model
from django.db.models import Q
from .models import ChatMessage
from .serializers import ChatMessageSerializer

User = get_user_model()


async def get_async_redis_connection():
    """
    Creates and returns an async Redis connection.
    """
    redis_url = settings.CHANNEL_LAYERS['default']['CONFIG']['hosts'][0]
    return await async_redis.from_url(redis_url, decode_responses=True)


class PresenceConsumer(AsyncWebsocketConsumer):
    async def connect(self):
        self.user = self.scope['user']
        if not self.user.is_authenticated:
            await self.close()
            return

        await self.accept()
        self.redis = await get_async_redis_connection()
        await self.redis.sadd('online_users', self.user.username)
        await self.channel_layer.group_add("presence_group", self.channel_name)
        await self.send_presence_updates()
        print(f"Presence: User {self.user.username} connected.")

    async def disconnect(self, close_code):
        if self.user.is_authenticated and hasattr(self, 'redis'):
            await self.redis.srem('online_users', self.user.username)
            await self.channel_layer.group_discard("presence_group", self.channel_name)
            await self.send_presence_updates()
            await self.redis.close()
            print(f"Presence: User {self.user.username} disconnected.")

    @database_sync_to_async
    def _get_users_by_username(self, usernames):
        """Helper to fetch users from DB in a single query."""
        users = User.objects.filter(username__in=usernames).values('id', 'username')
        return list(users)

    async def send_presence_updates(self):
        if not hasattr(self, 'redis') or self.redis.connection is None:
            self.redis = await get_async_redis_connection()

        # OPTIMIZED: Fetch all users in one query to prevent N+1 problem
        online_usernames = list(await self.redis.smembers('online_users'))
        users_with_ids = await self._get_users_by_username(online_usernames) if online_usernames else []
        
        available_rooms_list = await self.redis.smembers('available_public_rooms')
        detailed_rooms = []
        for room_name in sorted(list(available_rooms_list)):
            user_count = await self.redis.scard(f'room:{room_name}:active_users')
            detailed_rooms.append({'name': room_name, 'online_count': user_count})

        await self.channel_layer.group_send(
            "presence_group",
            {
                'type': 'presence.broadcast',
                'users': sorted(users_with_ids, key=lambda u: u['username']),
                'detailed_rooms': detailed_rooms,
            }
        )
    
    async def room_activity_update(self, event_data):
        room_name, username, action = event_data['room_name'], event_data['username'], event_data['action']
        room_key = f'room:{room_name}:active_users'
        await self.redis.sadd('available_public_rooms', room_name)
        if action == 'joined':
            await self.redis.sadd(room_key, username)
        elif action == 'left':
            await self.redis.srem(room_key, username)
        await self.send_presence_updates()

    async def presence_broadcast(self, event_data):
        await self.send(text_data=json.dumps({'type': 'user_list', 'users': event_data['users']}))
        await self.send(text_data=json.dumps({'type': 'detailed_room_list', 'rooms': event_data['detailed_rooms']}))


class ChatConsumer(AsyncWebsocketConsumer):
    def is_dm_room(self, room_name_str):
        return room_name_str.startswith('dm_')

    async def connect(self):
        self.user = self.scope['user']
        if not self.user.is_authenticated:
            await self.close()
            return
            
        self.actual_room_name = self.scope['url_route']['kwargs']['room_name']
        self.room_group_name = f'chat_{self.actual_room_name}'
        
        await self.accept()
        self.redis = await get_async_redis_connection()
        await self.channel_layer.group_add(self.room_group_name, self.channel_name)

        if not self.is_dm_room(self.actual_room_name):
            await self.channel_layer.group_send("presence_group", {
                'type': 'room.activity.update', 'room_name': self.actual_room_name, 
                'username': self.user.username, 'action': 'joined'
            })

    async def disconnect(self, close_code):
        if self.user.is_authenticated:
            if not self.is_dm_room(self.actual_room_name):
                await self.channel_layer.group_send("presence_group", {
                    'type': 'room.activity.update', 'room_name': self.actual_room_name, 
                    'username': self.user.username, 'action': 'left'
                })
        
        await self.channel_layer.group_discard(self.room_group_name, self.channel_name)
        if hasattr(self, 'redis'):
            await self.redis.close()

    async def receive(self, text_data):
        if not self.user.is_authenticated:
            return

        text_data_json = json.loads(text_data)
        event_type = text_data_json.get('type')

        if event_type == "mark_read" and text_data_json.get('message_id'):
            await self.mark_message_as_read(text_data_json.get('message_id'))
        
        elif event_type == "chat_message":
            await self.save_and_broadcast_message(text_data_json)

    # --- Message Handling Logic ---
    async def get_last_messages(self, room_name):
        """Fetches message history, trying cache first then DB."""
        cache_key = f'chat_history:{room_name}'
        cached_messages = await self.redis.lrange(cache_key, 0, -1)

        if cached_messages:
            print(f"HISTORY from CACHE for {room_name}")
            return [json.loads(msg) for msg in cached_messages]

        print(f"HISTORY from DB for {room_name}")
        db_messages = await self._get_messages_from_db(room_name)
        
        if db_messages: # Populate cache for next time
            pipeline = self.redis.pipeline()
            for msg_data in db_messages:
                await pipeline.rpush(cache_key, json.dumps(msg_data))
            await pipeline.execute()
        return db_messages

    @database_sync_to_async
    def _get_messages_from_db(self, room_name):
        """Helper to fetch last 50 messages from database."""
        if self.is_dm_room(room_name):
            try:
                user1_name, user2_name = room_name.split('_')
                user1 = User.objects.get(username=user1_name)
                user2 = User.objects.get(username=user2_name)
                q_filter = Q(is_dm=True) & ((Q(sender=user1, receiver=user2) | Q(sender=user2, receiver=user1)))
            except User.DoesNotExist:
                return []
        else:
            q_filter = Q(room_name=room_name, is_dm=False)
        
        queryset = ChatMessage.objects.filter(q_filter).order_by('-timestamp')[:50]
        serializer = ChatMessageSerializer(reversed(queryset), many=True)
        return serializer.data

    @database_sync_to_async
    def _save_message_to_db(self, message_data, is_dm, receiver_instance):
        """Saves a message object to the database and returns serialized data."""
        new_message = ChatMessage.objects.create(
            sender=self.user,
            message=message_data.get('message'),
            image_content=message_data.get('image_content'),
            message_type=message_data.get('msg_type', 'text'),
            room_name=self.actual_room_name,
            is_dm=is_dm,
            receiver=receiver_instance
        )
        return ChatMessageSerializer(new_message).data

    async def save_and_broadcast_message(self, message_data):
        """Saves message to DB, caches it, and broadcasts it to the room group."""
        is_dm = self.is_dm_room(self.actual_room_name)
        receiver_user_instance = None

        if is_dm:
            receiver_username = message_data.get('receiver')
            if not receiver_username: return
            try:
                receiver_user_instance = await database_sync_to_async(User.objects.get)(username=receiver_username)
            except User.DoesNotExist: return

        # 1. Save to DB (returns serialized data)
        saved_message = await self._save_message_to_db(message_data, is_dm, receiver_user_instance)

        # 2. Update Redis Cache using async client
        cache_key = f'chat_history:{self.actual_room_name}'
        await self.redis.rpush(cache_key, json.dumps(saved_message))
        await self.redis.ltrim(cache_key, -50, -1) # Keep cache size to 50

        # 3. Broadcast to Channel Layer Group
        await self.channel_layer.group_send(
            self.room_group_name, 
            {'type': 'chat.message.broadcast', **saved_message}
        )

    async def chat_message_broadcast(self, event_data):
        print("--- CORRECTED BROADCAST METHOD IS RUNNING ---")

        event_data.pop('type', None)
        await self.send(text_data=json.dumps({
            'type': 'chat_message', 
            **event_data
        }))

    # --- Read Receipt Logic ---
    async def mark_message_as_read(self, message_id):
        updated_data = await self._update_read_status_in_db(message_id)
        if updated_data:
            await self.channel_layer.group_send(self.room_group_name, {
                'type': 'read_receipt_broadcast', 
                **updated_data
            })
    
    @database_sync_to_async
    def _update_read_status_in_db(self, message_id):
        """Updates the is_read flag for a message in the database."""
        try:
            msg = ChatMessage.objects.get(id=message_id)
            if not msg.is_read:
                msg.is_read = True
                msg.save(update_fields=['is_read'])
                return {"message_id": msg.id, "reader": self.user.username, "timestamp": str(msg.timestamp)}
            return None
        except ChatMessage.DoesNotExist:
            return None

    async def read_receipt_broadcast(self, event_data):
        """Sends a read receipt event to the WebSocket client."""

        event_data.pop('type', None)

        await self.send(text_data=json.dumps({'type': 'read_receipt', **event_data}))