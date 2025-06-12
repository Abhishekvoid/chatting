from django.db import models
from django.contrib.auth import get_user_model

User = get_user_model()

class ChatMessage(models.Model):
    sender = models.ForeignKey(User, on_delete=models.CASCADE, related_name='sent_messages')
    message = models.TextField(blank=True, null=True)
    image_content = models.TextField(blank=True, null=True)  # Base64 encoded image
    message_type = models.CharField(max_length=10, default='text')  
    room_name = models.CharField(max_length=255, blank=True, null=True)
    is_dm = models.BooleanField(default=False)
    receiver = models.ForeignKey(User, on_delete=models.CASCADE, related_name='received_messages', null=True, blank=True)
    is_read = models.BooleanField(default=False) 
    timestamp = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['-timestamp']

    def __str__(self):
        return f'{self.sender.username}: {self.message[:50] if self.message else "[image]"}'