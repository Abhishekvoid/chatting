# chat/asgi.py
import os 

# Set Django settings module BEFORE any other Django-related imports
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'chat.settings')

import django 
django.setup() 

from django.core.asgi import get_asgi_application
from channels.routing import ProtocolTypeRouter, URLRouter
from channels.auth import AuthMiddlewareStack # Keep AuthMiddlewareStack for now
from django.urls import path

# NEW: Import your custom JWTAuthMiddleware
from chat.middleware import JWTAuthMiddleware 

from chatbox import consumers 

application = ProtocolTypeRouter({
    "http": get_asgi_application(),
    # NEW: Use your custom JWTAuthMiddleware
    "websocket": JWTAuthMiddleware(
        URLRouter([
            path("ws/chat/<str:room_name>/", consumers.ChatConsumer.as_asgi()),
            path("ws/presence/", consumers.PresenceConsumer.as_asgi()),
        ])
    ),
})
