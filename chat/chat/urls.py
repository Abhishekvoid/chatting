# chat/urls.py
from django.contrib import admin
from django.urls import path, include

# Import Simple JWT's TokenObtainPairView
from rest_framework_simplejwt.views import TokenObtainPairView, TokenRefreshView

# Import your custom serializer
from chatbox.serializers import MyTokenObtainPairSerializer # NEW: Import your custom serializer

urlpatterns = [
    path('admin/', admin.site.urls),
    path('api/auth/jwt/create/', TokenObtainPairView.as_view(serializer_class=MyTokenObtainPairSerializer), name='jwt_create'), # OVERRIDDEN
    path('api/auth/', include('djoser.urls')), 
    path('api/auth/', include('djoser.urls.jwt')), 
    path('api/', include('chatbox.urls')),
]

