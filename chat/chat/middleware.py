# chat/middleware.py
from channels.db import database_sync_to_async
from django.contrib.auth.models import AnonymousUser
from rest_framework_simplejwt.exceptions import TokenError
from rest_framework_simplejwt.tokens import AccessToken
from django.contrib.auth import get_user_model
from urllib.parse import parse_qs

User = get_user_model()

@database_sync_to_async
def get_user_from_token(token_key):
    """
    Attempts to retrieve a user from a JWT token.
    """
    try:
        # Validate the token using simplejwt's AccessToken
        access_token = AccessToken(token_key)
        user_id = access_token['user_id'] # Get user_id from token payload
        user = User.objects.get(id=user_id)
        return user
    except User.DoesNotExist:
        print("JWTAuthMiddleware: User not found for ID in token.")
        return AnonymousUser()
    except TokenError as e:
        print(f"JWTAuthMiddleware: Token validation failed: {e}")
        return AnonymousUser()

class JWTAuthMiddleware:
    """
    Custom middleware to authenticate WebSocket connections using JWT from query string.
    """
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
       
        query_string = scope['query_string'].decode()
        query_params = parse_qs(query_string)
        token = query_params.get('token')

        if token:
            # Get the user asynchronously using the token
            scope['user'] = await get_user_from_token(token[0])
            print(f"JWTAuthMiddleware: Authenticated user for WS: {scope['user'].username if scope['user'].is_authenticated else 'Anonymous'}")
        else:
            scope['user'] = AnonymousUser()
            print("JWTAuthMiddleware: No token found in WS query string.")

        return await self.app(scope, receive, send)
