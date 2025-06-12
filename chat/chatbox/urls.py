# chatbox/urls.py
from django.urls import path
from .views import ChatMessageListCreateView # Only need this view now

urlpatterns = [
    path('messages/', ChatMessageListCreateView.as_view(), name='chat-message-list-create'),

]
