# chatbox/serializers.py
from rest_framework import serializers
from rest_framework_simplejwt.serializers import TokenObtainPairSerializer
from django.contrib.auth import get_user_model

# Djoser imports (keep these for the other serializers)
from djoser.serializers import UserCreateSerializer as DjoserUserCreateSerializer
from djoser.serializers import UserSerializer as DjoserUserSerializer

from .models import ChatMessage

User = get_user_model()


# --- THIS IS THE ONLY TOKEN SERIALIZER YOU NEED FOR JWT LOGIN ---
class MyTokenObtainPairSerializer(TokenObtainPairSerializer):
    """
    This serializer handles the /api/auth/jwt/create/ endpoint.
    It customizes both the token payload and the login response body.
    """

    @classmethod
    def get_token(cls, user):
       
        token = super().get_token(user)
        token['username'] = user.username
        token['email'] = user.email
        
        return token

    def validate(self, attrs):
        data = super().validate(attrs)

       
        data['username'] = self.user.username
        data['email'] = self.user.email
        # You can add any other user fields here if needed.

        return data




class UserCreateSerializer(DjoserUserCreateSerializer):
    class Meta(DjoserUserCreateSerializer.Meta):
        model = User
        fields = ('id', 'username', 'email', 'password')

# Djoser UserSerializer (for /users/me/ endpoint) - CORRECT
class UserSerializer(DjoserUserSerializer):
    class Meta(DjoserUserSerializer.Meta):
        model = User
        fields = ('id', 'username', 'email', 'first_name', 'last_name')

class NestedUserSerializer(serializers.ModelSerializer):
    """A small serializer for nested user data."""
    class Meta:
        model = User
        fields = ['id', 'username']


class ChatMessageSerializer(serializers.ModelSerializer):
    """
    This serializer now ensures that the 'sender' and 'receiver' fields
    are represented by a nested object containing their ID and username.
    """
    sender = NestedUserSerializer(read_only=True)
    receiver = NestedUserSerializer(read_only=True, allow_null=True)

    class Meta:
        model = ChatMessage
        fields = [
            'id', 
            'sender',         
            'receiver',      
            'message', 
            'image_content',
            'message_type', 
            'room_name', 
            'is_dm', 
            'timestamp', 
            'is_read'
        ]
        read_only_fields = ('id', 'sender', 'receiver', 'timestamp')