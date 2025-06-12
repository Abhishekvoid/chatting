# chatbox/views.py
from rest_framework import generics, permissions
from .models import ChatMessage 
from .serializers import ChatMessageSerializer 

# No need for custom LoginView or RegisterView here, Djoser provides them.

class ChatMessageListCreateView(generics.ListCreateAPIView):
    serializer_class = ChatMessageSerializer
    permission_classes = [permissions.IsAuthenticated]

    def get_queryset(self):
        user = self.request.user
        room_name = self.request.query_params.get('room_name')
        is_dm = self.request.query_params.get('is_dm', 'false').lower() == 'true'
        receiver_id = self.request.query_params.get('receiver_id')

        if room_name and not is_dm:
            return ChatMessage.objects.filter(room_name=room_name)
        elif is_dm and receiver_id:
            return ChatMessage.objects.filter(
                models.Q(sender=user, receiver_id=receiver_id, is_dm=True) |
                models.Q(sender_id=receiver_id, receiver=user, is_dm=True)
            )
        return ChatMessage.objects.none()

    def perform_create(self, serializer):
        serializer.save(sender=self.request.user)
