# chatbox/consumers.py
print("!!!!!!!!!! FIXED CONSUMER - STABLE WEBSOCKET HANDLING !!!!!!!!!!")
import json
import redis.asyncio as async_redis
from django.conf import settings
from channels.generic.websocket import AsyncWebsocketConsumer
from channels.db import database_sync_to_async
from django.contrib.auth import get_user_model
from django.db.models import Q
from django.utils import timezone
from .models import ChatMessage
from .serializers import ChatMessageSerializer
import logging
import asyncio

User = get_user_model()
logger = logging.getLogger(__name__)

class RedisConnectionManager:
    """Manages Redis connections to prevent connection leaks and ensure stability."""
    
    def __init__(self):
        self._connection = None
        self._lock = asyncio.Lock()
    
    async def get_connection(self):
        async with self._lock:
            if self._connection is None or not await self._connection.ping():
                try:
                    redis_url = settings.CHANNEL_LAYERS['default']['CONFIG']['hosts'][0]
                    self._connection = await async_redis.from_url(
                        redis_url, 
                        decode_responses=True,
                        socket_connect_timeout=5,
                        socket_keepalive=True,
                        retry_on_timeout=True,
                        health_check_interval=30
                    )
                    logger.info("Successfully established new Redis connection.")
                except Exception as e:
                    logger.error(f"Failed to create Redis connection: {e}")
                    raise
            return self._connection
    
    async def close(self):
        async with self._lock:
            if self._connection:
                try:
                    await self._connection.close()
                    logger.info("Redis connection closed.")
                except Exception as e:
                    logger.error(f"Error closing Redis connection: {e}")
                finally:
                    self._connection = None


class PresenceConsumer(AsyncWebsocketConsumer):
    # This consumer class appears to be well-structured. No changes are needed here.
    # ... (Your existing PresenceConsumer code)
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.redis_manager = RedisConnectionManager()
        self.user = None

    async def connect(self):
        try:
            self.user = self.scope['user']
            if not self.user.is_authenticated:
                await self.close()
                return

            await self.accept()
            
            # Get Redis connection through manager
            redis_conn = await self.redis_manager.get_connection()
            await redis_conn.sadd('online_users', self.user.username)
            
            await self.channel_layer.group_add("presence_group", self.channel_name)
            await self.send_presence_updates()
            logger.info(f"Presence: User {self.user.username} connected.")
            
        except Exception as e:
            logger.error(f"Error in PresenceConsumer connect: {e}")
            await self.close()

    async def receive(self, text_data):
        """Safely handle any unexpected messages to prevent crashes."""
        try:
            logger.debug(f"PresenceConsumer received unexpected message from {self.user.username if self.user else 'unknown'}. Ignoring.")
        except Exception as e:
            logger.error(f"Error in PresenceConsumer receive: {e}")

    async def disconnect(self, close_code):
        try:
            if self.user and self.user.is_authenticated:
                redis_conn = await self.redis_manager.get_connection()
                await redis_conn.srem('online_users', self.user.username)
                await self.channel_layer.group_discard("presence_group", self.channel_name)
                await self.send_presence_updates()
                logger.info(f"Presence: User {self.user.username} disconnected.")
        except Exception as e:
            logger.error(f"Error in PresenceConsumer disconnect: {e}")
        finally:
            await self.redis_manager.close()

    @database_sync_to_async
    def _get_users_by_username(self, usernames):
        """Helper to fetch users from DB in a single query."""
        try:
            users = User.objects.filter(username__in=usernames).values('id', 'username')
            return list(users)
        except Exception as e:
            logger.error(f"Error fetching users: {e}")
            return []

    async def send_presence_updates(self):
        try:
            redis_conn = await self.redis_manager.get_connection()
            online_usernames = list(await redis_conn.smembers('online_users'))
            users_with_ids = await self._get_users_by_username(online_usernames) if online_usernames else []
            
            available_rooms_list = await redis_conn.smembers('available_public_rooms')
            detailed_rooms = []
            
            for room_name in sorted(list(available_rooms_list)):
                try:
                    user_count = await redis_conn.scard(f'room:{room_name}:active_users')
                    detailed_rooms.append({'name': room_name, 'online_count': user_count})
                except Exception as e:
                    logger.error(f"Error getting room count for {room_name}: {e}")
                    detailed_rooms.append({'name': room_name, 'online_count': 0})
            
            await self.channel_layer.group_send("presence_group", {
                'type': 'presence.broadcast',
                'users': sorted(users_with_ids, key=lambda u: u['username']),
                'detailed_rooms': detailed_rooms,
            })
        except Exception as e:
            logger.error(f"Error in send_presence_updates: {e}")
    
    async def room_activity_update(self, event_data):
        try:
            room_name = event_data['room_name']
            username = event_data['username']
            action = event_data['action']
            
            redis_conn = await self.redis_manager.get_connection()
            room_key = f'room:{room_name}:active_users'
            
            await redis_conn.sadd('available_public_rooms', room_name)
            
            if action == 'joined':
                await redis_conn.sadd(room_key, username)
            elif action == 'left':
                await redis_conn.srem(room_key, username)
            
            await self.send_presence_updates()
        except Exception as e:
            logger.error(f"Error in room_activity_update: {e}")

    async def presence_broadcast(self, event_data):
        try:
            await self.send(text_data=json.dumps({
                'type': 'user_list', 
                'users': event_data['users']
            }))
            await self.send(text_data=json.dumps({
                'type': 'detailed_room_list', 
                'rooms': event_data['detailed_rooms']
            }))
        except Exception as e:
            logger.error(f"Error in presence_broadcast: {e}")


class ChatConsumer(AsyncWebsocketConsumer):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.redis_manager = RedisConnectionManager()
        self.user = None
        self.actual_room_name = None
        self.room_group_name = None

    # ... (connect, disconnect, and other helper methods are fine) ...
    def is_dm_room(self, room_name_str):
        return room_name_str.startswith('dm_')

    def generate_cache_key(self, room_name):
        """Generate consistent cache key matching the API logic."""
        return f'chat_history:{room_name}'

    async def connect(self):
        try:
            logger.info("--- CONNECTING WITH FIXED, STABLE CONSUMER CODE ---")
            self.user = self.scope['user']
            
            if not self.user.is_authenticated:
                logger.warning("Unauthenticated user attempted to connect")
                await self.close()
                return

            self.actual_room_name = self.scope['url_route']['kwargs']['room_name']
            self.room_group_name = f'chat_{self.actual_room_name}'
            
            await self.accept()
            
            # Initialize Redis connection
            await self.redis_manager.get_connection()
            
            await self.channel_layer.group_add(self.room_group_name, self.channel_name)
            
            # Update presence for public rooms
            if not self.is_dm_room(self.actual_room_name):
                await self.channel_layer.group_send("presence_group", {
                    'type': 'room.activity.update', 
                    'room_name': self.actual_room_name, 
                    'username': self.user.username, 
                    'action': 'joined'
                })
            
            logger.info(f"User {self.user.username} connected to room {self.actual_room_name}")
            
        except Exception as e:
            logger.error(f"Error in ChatConsumer connect: {e}")
            await self.close()

    async def disconnect(self, close_code):
        try:
            if self.user and self.user.is_authenticated:
                if not self.is_dm_room(self.actual_room_name):
                    await self.channel_layer.group_send("presence_group", {
                        'type': 'room.activity.update', 
                        'room_name': self.actual_room_name, 
                        'username': self.user.username, 
                        'action': 'left'
                    })
                
                await self.channel_layer.group_discard(self.room_group_name, self.channel_name)
                logger.info(f"User {self.user.username} disconnected from room {self.actual_room_name}")
        except Exception as e:
            logger.error(f"Error in ChatConsumer disconnect: {e}")
        finally:
            await self.redis_manager.close()

    async def receive(self, text_data):
        """Handle incoming WebSocket messages with comprehensive error handling."""
        try:
            if not self.user.is_authenticated:
                logger.warning("Received message from unauthenticated user")
                return
            try:
                text_data_json = json.loads(text_data)
            except json.JSONDecodeError as e:
                logger.error(f"Received malformed JSON from {self.user.username}: {e}")
                return

            event_type = text_data_json.get('type')
            if not event_type:
                logger.debug(f"Received message with no type from {self.user.username}. Ignoring.")
                return

            if event_type == "mark_read_batch":
                message_ids = text_data_json.get('message_ids')
                if message_ids and isinstance(message_ids, list):
                    await self.mark_messages_as_read(message_ids)
            elif event_type == "chat_message":
                await self.save_and_broadcast_message(text_data_json)
            else:
                logger.warning(f"Received unknown event type '{event_type}' from {self.user.username}")

        except Exception as e:
            logger.error(f"CRITICAL ERROR in receive for user {self.user.username}: {e}")
    
    # ... (save_and_broadcast_message and its helpers are fine) ...
    @database_sync_to_async
    def _save_message_to_db(self, message_data, is_dm, receiver_instance):
        """Save message to database with error handling."""
        try:
            new_message = ChatMessage.objects.create(
                sender=self.user,
                message=message_data.get('message', ''),
                image_content=message_data.get('image_content'),
                message_type=message_data.get('msg_type', 'text'),
                room_name=self.actual_room_name,
                is_dm=is_dm,
                receiver=receiver_instance
            )
            return ChatMessageSerializer(new_message).data
        except Exception as e:
            logger.error(f"Error saving message to DB: {e}")
            return None

    async def save_and_broadcast_message(self, message_data):
        """Save and broadcast new message with proper error handling."""
        try:
            is_dm = self.is_dm_room(self.actual_room_name)
            receiver_user_instance = None
            
            if is_dm:
                receiver_username = message_data.get('receiver')
                if not receiver_username:
                    logger.warning(f"DM message missing receiver from {self.user.username}")
                    return
                
                try:
                    receiver_user_instance = await database_sync_to_async(User.objects.get)(username=receiver_username)
                except User.DoesNotExist:
                    logger.error(f"Receiver user {receiver_username} not found")
                    return

            saved_message = await self._save_message_to_db(message_data, is_dm, receiver_user_instance)
            if not saved_message:
                logger.error("Failed to save message to database")
                return

            try:
                redis_conn = await self.redis_manager.get_connection()
                cache_key = self.generate_cache_key(self.actual_room_name)
                
                await redis_conn.lpush(cache_key, json.dumps(saved_message))
                await redis_conn.ltrim(cache_key, 0, 49)
                
                logger.debug(f"CACHE UPDATED for {cache_key} with new message")
            except Exception as e:
                logger.error(f"Error updating cache: {e}")

            await self.channel_layer.group_send(self.room_group_name, {
                'type': 'chat.message.broadcast', 
                **saved_message
            })

        except Exception as e:
            logger.error(f"Error in save_and_broadcast_message: {e}")

    async def chat_message_broadcast(self, event_data):
        """Broadcast chat message to WebSocket."""
        try:
            broadcast_data = {k: v for k, v in event_data.items() if k != 'type'}
            await self.send(text_data=json.dumps({
                'type': 'chat_message', 
                **broadcast_data
            }))
        except Exception as e:
            logger.error(f"Error in chat_message_broadcast: {e}")


    # /-------------------------------------------------------\
    # |           REFACTORED READ RECEIPT LOGIC               |
    # \-------------------------------------------------------/

    @database_sync_to_async
    def _update_read_status_in_db(self, message_ids):
        """
        Efficiently updates read status in the database.
        Returns a list of message IDs that were successfully updated.
        """
        try:
            # Ensure we have a list of integers for the query
            valid_message_ids = [int(mid) for mid in message_ids if str(mid).isdigit()]
            if not valid_message_ids:
                return []

            # Find messages that this user has received and which are still unread.
            messages_to_update = ChatMessage.objects.filter(
                id__in=valid_message_ids, 
                is_read=False, 
                receiver=self.user
            )
            
            # Get the IDs before updating to know which ones are changing.
            updated_ids = list(messages_to_update.values_list('id', flat=True))
            
            if updated_ids:
                # Perform the update in a single DB query.
                messages_to_update.update(is_read=True)
                logger.info(f"User {self.user.username} marked messages {updated_ids} as read.")
                return updated_ids
                
            return []
        except Exception as e:
            logger.error(f"Error updating read status in DB: {e}")
            return []

    async def mark_messages_as_read(self, message_ids):
        """
        Handles a request to mark messages as read, invalidates cache,
        and broadcasts a single confirmation to the group.
        """
        try:
            # Step 1: Update the database and get the list of IDs that were actually changed.
            updated_ids = await self._update_read_status_in_db(message_ids)
            
            if updated_ids:
                # Step 2: Invalidate the Redis cache for this room so the API serves fresh data.
                try:
                    redis_conn = await self.redis_manager.get_connection()
                    cache_key = self.generate_cache_key(self.actual_room_name)
                    await redis_conn.delete(cache_key)
                    logger.debug(f"CACHE INVALIDATED for {cache_key} because of read receipt.")
                except Exception as e:
                    logger.error(f"Error invalidating cache after read receipt: {e}")

                # Step 3: Broadcast a single, efficient message to the entire group.
                await self.channel_layer.group_send(self.room_group_name, {
                    'type': 'read_receipts_broadcast', 
                    'room_name': self.actual_room_name, 
                    'message_ids': updated_ids,
                    'reader_username': self.user.username,
                })
        except Exception as e:
            logger.error(f"Error in mark_messages_as_read: {e}")

    async def read_receipts_broadcast(self, event_data):
        """
        Sends the batch of read receipt data to the client's WebSocket.
        """
        try:
            # The client will receive a single event with all the necessary info.
            await self.send(text_data=json.dumps({
                'type': 'messages_marked_as_read', # A clear, specific event type for the frontend
                'room_name': event_data['room_name'],
                'message_ids': event_data['message_ids'],
                'reader_username': event_data['reader_username'],
            }))
        except Exception as e:
            logger.error(f"Error broadcasting read receipts: {e}")