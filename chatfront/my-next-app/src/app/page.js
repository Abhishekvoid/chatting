"use client";

import React, { useEffect, useRef, useState, useCallback } from "react";
import {
  FaPlus,
  FaSignOutAlt,
  FaCommentDots,
  FaUsers,
  FaHashtag,
  FaHome,
  FaPaperPlane,
  FaImage,
  FaCheck,
  FaCheckDouble,
} from "react-icons/fa";
import axios from "axios";
import { jwtDecode } from "jwt-decode";

// --- Configuration ---
const API_BASE_URL = "http://192.168.0.25:8000/api";
const WEBSOCKET_HOST = "192.168.0.25:8000";

export default function ChatComponent() {
  // --- State Management ---
  const [view, setView] = useState("loading");
  const [authTokens, setAuthTokens] = useState(null);
  const [userPayload, setUserPayload] = useState(null);
  const [username, setUsername] = useState("");

  const [loginUsername, setLoginUsername] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [regUsername, setRegUsername] = useState("");
  const [regEmail, setRegEmail] = useState("");
  const [regPassword, setRegPassword] = useState("");
  const [regPassword2, setRegPassword2] = useState("");

  const [onlineUsers, setOnlineUsers] = useState([]);
  const [availableRooms, setAvailableRooms] = useState([]);
  const [userJoinedRooms, setUserJoinedRooms] = useState([]);
  const [activeConversations, setActiveConversations] = useState([]);

  const [activeChat, setActiveChat] = useState(null);
  const [activeChatType, setActiveChatType] = useState(null);
  const [messages, setMessages] = useState({});

  const [messageInput, setMessageInput] = useState("");
  const [roomInput, setRoomInput] = useState("");
  const [unreadCounts, setUnreadCounts] = useState({});

  const [messageHistory, setMessageHistory] = useState({});
  const [chatConnecting, setChatConnecting] = useState({}); 

  const globalWs = useRef(null);
  const chatWs = useRef({});
  const messagesEndRef = useRef(null);
  const chatContainerRef = useRef(null);
  const onMessageHandlerRef = useRef(null);

  // --- Logic Functions ---

  const getOtherUserName = useCallback(
    (convoIdentifier) => {
      if (
        convoIdentifier &&
        typeof convoIdentifier === "object" &&
        convoIdentifier.username
      ) {
        return convoIdentifier.username;
      }

      if (
        typeof convoIdentifier === "string" &&
        convoIdentifier.includes("_")
      ) {
        const usersInRoom = convoIdentifier.split("_");
        return usersInRoom.find((name) => name !== username) || "User";
      }

      return convoIdentifier;
    },
    [username]
  );

  const getCurrentChatIdentifier = useCallback(() => {
    // We need userPayload to get the current user's ID
    if (!userPayload || !activeChat || !activeChatType) return null;

    if (activeChatType === "dm") {
        // This logic now perfectly matches establishChatConnection
        const user_ids = [userPayload.user_id, activeChat.id].sort((a, b) => a - b);
        return `dm_${user_ids[0]}_${user_ids[1]}`;
    }
    if (activeChatType === "room") {
        return activeChat;
    }
    return null;
}, [userPayload, activeChat, activeChatType]);
const showNotification = (title, body, tag) => {
  // First, check if the user has granted permission
  if (Notification.permission === 'granted') {
    
    const notification = new Notification(title, {
      body: body,
      tag: tag, // Using a tag prevents spamming multiple notifications for the same chat
    });

    // Optional: When the user clicks the notification, it brings them to the chat window
    notification.onclick = () => {
      window.focus();
    };
  }
};
  const formatTimestamp = (timestamp) => {
    if (!timestamp) return "";
    try {
      return new Date(timestamp).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch (error) {
      console.error("Timestamp format error:", error);
      return "";
    }
  };

  const markMessageAsReadOnServer = useCallback((chatId, messageId) => {
    const targetSocket = chatWs.current[chatId];
    if (
      targetSocket &&
      targetSocket.readyState === WebSocket.OPEN &&
      messageId
    ) {
      targetSocket.send(
        JSON.stringify({ type: "mark_read", message_id: messageId })
      );
    }
  }, []);

  const handleSocketMessage = useCallback(
    (e) => {
      const data = JSON.parse(e.data);
      console.log("[FRONTEND RECEIVED MESSAGE]:", data);

      const currentChatId = getCurrentChatIdentifier();

      if (data.type === "chat_message") {
        const messageData = data;
        let messageOriginChatId;

    
        if (messageData.is_dm) {
            const user_ids = [messageData.sender.id, messageData.receiver.id].sort((a,b) => a - b);
            messageOriginChatId = `dm_${user_ids[0]}_${user_ids[1]}`;
        } else {
            messageOriginChatId = messageData.room_name;
        }

        setMessages((prev) => {
            const existingMsgs = prev[messageOriginChatId] || [];
            const updatedMessages = [...existingMsgs, messageData];
            const uniqueMessages = Array.from(new Map(updatedMessages.map(item => [item.id, item])).values());
            const sortedMessages = [...uniqueMessages].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
            
            return { ...prev, [messageOriginChatId]: sortedMessages };
        });

        // This logic now needs to check sender.username
        if (username && messageData.sender.username !== username) {
          if (messageOriginChatId === currentChatId) {
            markMessageAsReadOnServer(messageOriginChatId, messageData.id);
          } else {
            setUnreadCounts((prev) => ({
              ...prev,
              [messageOriginChatId]: (prev[messageOriginChatId] || 0) + 1,
            }));
            
           
            showNotification(
              `New message from ${messageData.sender.username}`,
              messageData.message || 'Sent an image', 
              messageOriginChatId
            );
          }
        }
      } else if (data.type === "read_receipt") {
        if (currentChatId) {
          setMessages((prevMessages) => {
            const updatedMessagesForChat = (
              prevMessages[currentChatId] || []
            ).map((msg) => {
              if (msg.id === data.message_id) return { ...msg, is_read: true };
              return msg;
            });
            return { ...prevMessages, [currentChatId]: updatedMessagesForChat };
          });
        }
      }
    },
    [username, getCurrentChatIdentifier, markMessageAsReadOnServer]
);

  const logoutUser = useCallback(async () => {
    setAuthTokens(null);
    setUserPayload(null);
    setUsername("");
    localStorage.removeItem("authTokens");
    if (globalWs.current) {
      globalWs.current.onclose = null;
      globalWs.current.close();
      globalWs.current = null;
    }
    Object.values(chatWs.current).forEach((s) => {
      if (s) {
        s.onclose = null;
        s.close();
      }
    });
    chatWs.current = {};
    setOnlineUsers([]);
    setAvailableRooms([]);
    setUserJoinedRooms([]);
    setActiveConversations([]);
    setActiveChat(null);
    setActiveChatType(null);
    setMessages({});
    setUnreadCounts({});
    setMessageHistory({});
    setView("login");
  }, []);

  const loginUser = async (currentLoginUsername, currentLoginPassword) => {
    try {
      const response = await axios.post(`${API_BASE_URL}/auth/jwt/create/`, {
        username: currentLoginUsername,
        password: currentLoginPassword,
      });
      if (response.status === 200 && response.data.access) {
        const newTokens = response.data;
        setAuthTokens(newTokens);
        const decodedPayload = jwtDecode(newTokens.access);
        setUserPayload(decodedPayload);
        localStorage.setItem("authTokens", JSON.stringify(newTokens));
        if (decodedPayload?.username) {
          setUsername(decodedPayload.username);
          setView("chat");
          return true;
        } else {
          throw new Error("Username missing in token.");
        }
      } else {
        throw new Error("Login failed: Invalid server response.");
      }
    } catch (error) {
      const errorMsg =
        error.response?.data?.detail ||
        error.response?.data?.non_field_errors?.[0] ||
        error.message ||
        "Login failed!";
      alert(errorMsg);
      logoutUser();
      return false;
    }
  };

  const registerUser = async (
    currentRegUsername,
    currentRegEmail,
    currentRegPassword
  ) => {
    try {
      const response = await axios.post(`${API_BASE_URL}/auth/users/`, {
        username: currentRegUsername,
        email: currentRegEmail,
        password: currentRegPassword,
      });
      if (response.status === 201) {
        return await loginUser(currentRegUsername, currentRegPassword);
      } else {
        throw new Error(`Registration failed: Status ${response.status}`);
      }
    } catch (error) {
      let readableError = "Registration failed!";
      if (error.response?.data) {
        Object.entries(error.response.data).forEach(([key, value]) => {
          readableError += `\n${key.charAt(0).toUpperCase() + key.slice(1)}: ${
            Array.isArray(value) ? value.join(", ") : value
          }`;
        });
      } else {
        readableError = error.message || readableError;
      }
      alert(readableError);
      return false;
    }
  };

  const fetchUserInitialChats = useCallback(
    async (tokens) => {
      if (!tokens?.access) return;
      try {
        const response = await axios.get(`${API_BASE_URL}/user-chats/`, {
          headers: { Authorization: `Bearer ${tokens.access}` },
        });
        if (response.status === 200 && response.data) {
          const { dms = [], rooms = [] } = response.data;
          setActiveConversations((prevDMs) => {
            const newDMs = [...new Set([...prevDMs, ...dms])];
            return newDMs.sort((a, b) =>
              getOtherUserName(a).localeCompare(getOtherUserName(b))
            );
          });
          setUserJoinedRooms((prevRooms) => {
            const newRooms = [...new Set([...prevRooms, ...rooms])];
            return newRooms.sort();
          });
        }
      } catch (error) {
        console.error(
          "Failed to fetch user's initial chats:",
          error.response ? error.response.data : error.message
        );
        if (
          error.response &&
          (error.response.status === 401 || error.response.status === 403)
        ) {
          alert("Session expired or invalid. Please log in again.");
          logoutUser();
        }
      }
    },
    [getOtherUserName, logoutUser]
  );

  const fetchChatHistory = useCallback(
    async (chatId, chatType, receiverId) => {
      if (!authTokens) return;

      const historyState = messageHistory[chatId] || {};
      if (historyState.loading || historyState.next === null) return;

      setMessageHistory((prev) => ({
        ...prev,
        [chatId]: { ...prev[chatId], loading: true },
      }));

      const url = historyState.next
        ? historyState.next
        : `${API_BASE_URL}/messages/?${
            chatType === "dm"
              ? `receiver_id=${receiverId}`
              : `room_name=${chatId}`
          }`;

      try {
        const response = await axios.get(url, {
          headers: { Authorization: `Bearer ${authTokens.access}` },
        });

        const { results, next } = response.data;

        // This is the correct logic for a list of older messages
        setMessages((prev) => {
          // Use the 'chatId' parameter that belongs to this function
          const existingMessages = prev[chatId] || [];
          
          // The API sends newest-to-oldest. We reverse for chronological order.
          const chronologicallyOrderedResults = results.slice().reverse();
      
          // Prepend the new (older) page of messages
          const updatedMessages = [...chronologicallyOrderedResults, ...existingMessages];
      
          // Guarantee uniqueness
          const uniqueMessages = Array.from(new Map(updatedMessages.map(item => [item.id, item])).values());
      
          // Use the correct 'chatId' variable here as well
          return { ...prev, [chatId]: uniqueMessages };
      });

        setMessageHistory((prev) => ({
          ...prev,
          [chatId]: { next: next, loading: false },
        }));
      } catch (error) {
        console.error("Failed to fetch chat history:", error);
        setMessageHistory((prev) => ({
          ...prev,
          [chatId]: { ...prev[chatId], loading: false },
        }));
      }
    },
    [authTokens, messageHistory]
  );
  const syncReadReceipts = useCallback(async (chatId) => {
    if (!authTokens || !chatId) return;

    try {
        // This now calls the original endpoint but with special parameters
        const response = await axios.get(`${API_BASE_URL}/messages/`, {
            headers: { Authorization: `Bearer ${authTokens.access}` },
            params: {
                conversation_id: chatId,
                sync_receipts: true // This activates the new mode on the backend
            }
        });

        const { read_message_ids } = response.data;

        if (read_message_ids && read_message_ids.length > 0) {
            console.log(`[Sync] Found ${read_message_ids.length} newly read messages.`);
            
            const readIdsSet = new Set(read_message_ids);

            setMessages(prev => {
                const existingMessages = prev[chatId] || [];
                
                const updatedMessages = existingMessages.map(msg => {
                    if (readIdsSet.has(msg.id) && !msg.is_read) {
                        return { ...msg, is_read: true };
                    }
                    return msg;
                });
                
                return { ...prev, [chatId]: updatedMessages };
            });
        }
    } catch (error) {
        console.error("Failed to sync read receipts:", error);
    }
}, [authTokens]);
  // page.js

  const establishChatConnection = useCallback(
    async (target, type) => {
      // 'target' is a user OBJECT for DMs (e.g., {id: 44, username: 'Luka'})
      // 'target' is a room name STRING for rooms (e.g., 'general')

      if (!authTokens?.access || !username) {
        logoutUser();
        return;
      }

      // For DMs, the target is an object.
      if (type === "dm" && username === target.username) {
        alert("You cannot chat with yourself!");
        return;
      }

      const token = authTokens.access;
      let chatIdentifier;
      let wsUrl;
      let receiverId = null;

      // --- THIS IS THE MOST IMPORTANT LOGIC BLOCK ---
      if (type === "dm") {
        // We are starting a DM, so 'target' is the user object.
        const targetId = target.id;
        receiverId = target.id; // <-- THE CRITICAL FIX: Get the ID from the object.

        const user_ids = [userPayload.user_id, targetId].sort((a, b) => a - b);
        chatIdentifier = `dm_${user_ids[0]}_${user_ids[1]}`;
        setChatConnecting(prev => ({ ...prev, [chatIdentifier]: true }));
        wsUrl = `ws://${WEBSOCKET_HOST}/ws/chat/${chatIdentifier}/?token=${token}`;

        // Add to sidebar logic...
        setActiveConversations((prev) => {
          if (!prev.some((dm) => dm.id === target.id)) {
            return [...prev, target].sort((a, b) =>
              a.username.localeCompare(b.username)
            );
          }
          return prev;
        });
      } else {
        // We are joining a room, so 'target' is just the room name string.
        chatIdentifier = target;
        wsUrl = `ws://${WEBSOCKET_HOST}/ws/chat/${chatIdentifier}/?token=${token}`;

        // Add to sidebar logic...
        setUserJoinedRooms((prev) => {
          if (!prev.includes(chatIdentifier)) {
            return [...prev, chatIdentifier].sort();
          }
          return prev;
        });
      }
      // ---------------------------------------------

      // Set the active chat.
      setActiveChat(target);
      setActiveChatType(type);

      // Fetch History with the CORRECT ID.
      // Now, receiverId will be a number for DMs and null for rooms.
      if (!messageHistory[chatIdentifier]) {
        fetchChatHistory(chatIdentifier, type, receiverId);
      }

      // --- WebSocket Connection Logic ---
      if (
        !chatWs.current[chatIdentifier] ||
        chatWs.current[chatIdentifier].readyState > 1
      ) {
        const socket = new WebSocket(wsUrl);
        chatWs.current[chatIdentifier] = socket;

        socket.onopen = () => {
          console.log(
            `[Frontend] WS Connected: ${type} chat ${chatIdentifier}`
          );
          
          setChatConnecting(prev => ({ ...prev, [chatIdentifier]: false }));
        }
        socket.onclose = (event) => {
          console.log(
            `[Frontend] WS Disconnected: ${type} chat ${chatIdentifier}. Code: ${event.code}`
          );
          delete chatWs.current[chatIdentifier];
        };
        socket.onerror = (e) =>
          console.error(
            `[Frontend] WS Error ${type} chat ${chatIdentifier}:`,
            e
          );

        socket.onmessage = (event) => onMessageHandlerRef.current(event);

        // --- Logic Functions ---
      }
    },
    [authTokens, username, logoutUser, fetchChatHistory, messageHistory]
  );

  const sendMessage = useCallback(
    (messagePayload) => {
      const currentChatId = getCurrentChatIdentifier();
      console.log(
        `[SendMessage] Attempting to send to chat ID: ${currentChatId}`
      );

      if (!username || !currentChatId) {
        console.error("[SendMessage] FAILED: No user or active chat ID.");
        return;
      }

      const currentChatSocket = chatWs.current[currentChatId];

      if (currentChatSocket) {
        console.log(
          `[SendMessage] Found socket for ${currentChatId}. State: ${currentChatSocket.readyState}`
        );
        if (currentChatSocket.readyState === WebSocket.OPEN) {
          const payload = {
            ...messagePayload,
            type: "chat_message",
            sender: username,
            room_name: activeChatType === "room" ? activeChat : null,
            is_dm: activeChatType === "dm",
            receiver: activeChatType === "dm" ? activeChat.username : null,
          };

          console.log("[SendMessage] Sending payload:", payload);
          currentChatSocket.send(JSON.stringify(payload));
        } else {
          alert(
            "Chat connection is not open. Please wait a moment and try again."
          );
          console.error(
            `[SendMessage] FAILED: Socket state is ${currentChatSocket.readyState}, not OPEN.`
          );
        }
      } else {
        alert(
          "Could not find the chat connection. Please try re-opening the chat."
        );
        console.error(
          `[SendMessage] FAILED: No socket found in chatWs.current for ID ${currentChatId}`
        );
      }
    },
    [username, activeChat, activeChatType, getCurrentChatIdentifier]
  );

  const sendChatMessage = useCallback(() => {
    if (!messageInput.trim()) return;
    sendMessage({
      message: messageInput,
      image_content: null,
      msg_type: "text",
    });
    setMessageInput("");
  }, [messageInput, sendMessage]);

  const handleImageUpload = useCallback(
    (e) => {
      const file = e.target.files[0];
      if (!file) return;
      if (file.size > 5 * 1024 * 1024) {
        alert("Image file size exceeds 5MB.");
        return;
      }
      const reader = new FileReader();
      reader.onloadend = () =>
        sendMessage({
          message: null,
          image_content: reader.result,
          msg_type: "image",
        });
      reader.readAsDataURL(file);
      if (e.target) e.target.value = null;
    },
    [sendMessage]
  );

  const leaveRoom = useCallback(
    async (roomToLeave) => {
      if (!userJoinedRooms.includes(roomToLeave)) return;
      try {
        if (chatWs.current[roomToLeave]) {
          chatWs.current[roomToLeave].onclose = null;
          chatWs.current[roomToLeave].close();
          delete chatWs.current[roomToLeave];
        }
        setUserJoinedRooms((prev) =>
          prev.filter((room) => room !== roomToLeave)
        );
        if (activeChat === roomToLeave && activeChatType === "room") {
          setActiveChat(null);
          setActiveChatType(null);
        }
        setMessages((prev) => {
          const newMsgs = { ...prev };
          delete newMsgs[roomToLeave];
          return newMsgs;
        });
        alert(`Successfully left room: ${roomToLeave}`);
      } catch (error) {
        console.error("Error leaving room:", error);
        alert("Failed to leave room.");
      }
    },
    [activeChat, activeChatType, userJoinedRooms]
  );

  const startChatWith = useCallback(
    (targetUser) => {
      // targetUser is the full object {id, username}
      establishChatConnection(targetUser, "dm");
    },
    [establishChatConnection]
  );

  const joinOrCreateRoom = useCallback(() => {
    if (roomInput.trim()) {
      establishChatConnection(roomInput.trim(), "room");
      setRoomInput("");
    }
  }, [roomInput, establishChatConnection]);

  // --- Effects ---
  useEffect(() => {
    onMessageHandlerRef.current = handleSocketMessage;
  });

  useEffect(() => {
    const chatContainer = chatContainerRef.current;
    if (!chatContainer) return;

    const scroll = () => {
      chatContainer.scrollTop = chatContainer.scrollHeight;
    };

    const timer = setTimeout(scroll, 100);
    return () => clearTimeout(timer);
  }, [messages]);
  useEffect(() => {
    const storedTokens = localStorage.getItem("authTokens");
    if (storedTokens) {
      try {
        const parsedTokens = JSON.parse(storedTokens);
        const decoded = jwtDecode(parsedTokens.access);
        if (decoded.exp * 1000 > Date.now()) {
          setAuthTokens(parsedTokens);
          setUserPayload(decoded);
          if (decoded.username) {
            setUsername(decoded.username);
          } else {
            logoutUser();
          }
        } else {
          logoutUser();
        }
      } catch (e) {
        logoutUser();
      }
    } else {
      setView("login");
    }
  }, [logoutUser]);

  useEffect(() => {
    if (username && authTokens && view === "loading") {
      fetchUserInitialChats(authTokens).then(() => {
        if (view === "loading") setView("chat");
      });
    }
    if (!authTokens && view !== "login" && view !== "signup") {
      setView("login");
    }
  }, [username, authTokens, view, fetchUserInitialChats]);

  useEffect(() => {
    let globalSocketInstance = null;
    if (view === "chat" && authTokens && username) {
      if (
        "Notification" in window &&
        Notification.permission !== "granted" &&
        Notification.permission !== "denied"
      ) {
        Notification.requestPermission();
      }
      globalSocketInstance = new WebSocket(
        `ws://${WEBSOCKET_HOST}/ws/presence/?token=${authTokens.access}`
      );
      globalWs.current = globalSocketInstance;
      globalSocketInstance.onopen = () =>
        console.log(`Global presence WS connected for '${username}'.`);
      globalSocketInstance.onclose = (event) => {
        console.log(
          `Global WS Disconnected for '${username}'. Code: ${event.code}`
        );
        if (globalWs.current === globalSocketInstance) {
          globalWs.current = null;
        }
      };
      globalSocketInstance.onerror = (e) =>
        console.error(`Global WS error for '${username}':`, e);
      globalSocketInstance.onmessage = (e) => {
        const data = JSON.parse(e.data);
        if (data.type === "user_list") {
          setOnlineUsers(data.users);
        }
        if (data.type === "detailed_room_list") {
          setAvailableRooms(data.rooms);
        }
      };
      return () => {
        if (globalSocketInstance) {
          globalSocketInstance.onclose = null;
          globalSocketInstance.close();
        }
        if (globalWs.current === globalSocketInstance) globalWs.current = null;
        Object.values(chatWs.current).forEach((s) => {
          if (s) {
            s.onclose = null;
            s.close();
          }
        });
        chatWs.current = {};
      };
    } else if (globalWs.current) {
      globalWs.current.onclose = null;
      globalWs.current.close();
      globalWs.current = null;
    }
  }, [view, authTokens, username]);

  useEffect(() => {
    const currentChatId = getCurrentChatIdentifier();
    if (view === "chat" && currentChatId && username) {
      if (unreadCounts[currentChatId] > 0) {
        setUnreadCounts((prev) => ({ ...prev, [currentChatId]: 0 }));
      }
      const chatMessages = messages[currentChatId] || [];
      chatMessages.forEach((msg) => {
        if (msg.sender.username !== username && !msg.is_read && msg.id) {
          markMessageAsReadOnServer(currentChatId, msg.id);
        }
      });
    }
    if (view === "chat") {
    }
  }, [
    messages,
    activeChat,
    activeChatType,
    view,
    username,
    getCurrentChatIdentifier,
    unreadCounts,
    markMessageAsReadOnServer,
  ]);

  const handleScroll = useCallback(
    (e) => {
      const chatIdentifier = getCurrentChatIdentifier();
      if (!chatIdentifier) return;
      if (e.target.scrollTop === 0) {
        fetchChatHistory(chatIdentifier, activeChatType, false);
      }
    },
    [getCurrentChatIdentifier, activeChatType, fetchChatHistory]
  );

  // --- Rendering (JSX) ---
  const renderLogin = () => (
    <div className="flex items-center justify-center h-screen bg-gray-900">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          loginUser(loginUsername, loginPassword);
        }}
        className="bg-gray-800 p-8 rounded-lg shadow-xl w-96"
      >
        <h2 className="text-2xl font-bold mb-6 text-white text-center">
          Login
        </h2>
        <input
          type="text"
          placeholder="Username"
          value={loginUsername}
          onChange={(e) => setLoginUsername(e.target.value)}
          className="w-full p-3 mb-4 bg-gray-700 text-white rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
          required
        />
        <input
          type="password"
          placeholder="Password"
          value={loginPassword}
          onChange={(e) => setLoginPassword(e.target.value)}
          className="w-full p-3 mb-6 bg-gray-700 text-white rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
          required
        />
        <button
          type="submit"
          className="w-full p-3 bg-blue-600 text-white rounded hover:bg-blue-700 transition-colors"
        >
          Login
        </button>
        <p className="mt-4 text-center text-gray-400">
          Don't have an account?{" "}
          <button
            type="button"
            onClick={() => setView("signup")}
            className="text-blue-500 hover:underline bg-transparent border-none cursor-pointer p-0"
          >
            Sign Up
          </button>
        </p>
      </form>
    </div>
  );

  const renderSignup = () => (
    <div className="flex items-center justify-center h-screen bg-gray-900">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (regPassword !== regPassword2) {
            alert("Passwords don't match!");
            return;
          }
          registerUser(regUsername, regEmail, regPassword);
        }}
        className="bg-gray-800 p-8 rounded-lg shadow-xl w-96"
      >
        <h2 className="text-2xl font-bold mb-6 text-white text-center">
          Sign Up
        </h2>
        <input
          type="text"
          placeholder="Username"
          value={regUsername}
          onChange={(e) => setRegUsername(e.target.value)}
          className="w-full p-3 mb-4 bg-gray-700 text-white rounded focus:outline-none focus:ring-2 focus:ring-green-500"
          required
        />
        <input
          type="email"
          placeholder="Email"
          value={regEmail}
          onChange={(e) => setRegEmail(e.target.value)}
          className="w-full p-3 mb-4 bg-gray-700 text-white rounded focus:outline-none focus:ring-2 focus:ring-green-500"
          required
        />
        <input
          type="password"
          placeholder="Password"
          value={regPassword}
          onChange={(e) => setRegPassword(e.target.value)}
          className="w-full p-3 mb-4 bg-gray-700 text-white rounded focus:outline-none focus:ring-2 focus:ring-green-500"
          required
        />
        <input
          type="password"
          placeholder="Confirm Password"
          value={regPassword2}
          onChange={(e) => setRegPassword2(e.target.value)}
          className="w-full p-3 mb-6 bg-gray-700 text-white rounded focus:outline-none focus:ring-2 focus:ring-green-500"
          required
        />
        <button
          type="submit"
          className="w-full p-3 bg-green-600 text-white rounded hover:bg-green-700 transition-colors"
        >
          Sign Up
        </button>
        <p className="mt-4 text-center text-gray-400">
          Already have an account?{" "}
          <button
            type="button"
            onClick={() => setView("login")}
            className="text-blue-500 hover:underline bg-transparent border-none cursor-pointer p-0"
          >
            Login
          </button>
        </p>
      </form>
    </div>
  );

  const renderChat = () => {
    console.log("5. [Render] The 'renderChat' function is running.");
    if (!username)
      return (
        <div className="flex items-center justify-center h-screen bg-gray-900 text-white">
          Finalizing session...
        </div>
      );
    const currentChatId = getCurrentChatIdentifier();
    const currentMessages = currentChatId ? messages[currentChatId] || [] : [];

    console.log(
      `6. [Render] Rendering chat for '${currentChatId}'. Found ${currentMessages.length} messages.`
    );
    return (
      <div className="flex h-screen bg-gray-900 text-gray-100">
        <div className="w-16 bg-gray-950 flex flex-col items-center py-3 space-y-3">
          <div
            className="w-12 h-12 rounded-full bg-blue-600 flex items-center justify-center text-white cursor-pointer hover:bg-blue-700"
            title="Home"
          >
            <FaHome size={24} />
          </div>
          <button
            onClick={logoutUser}
            className="w-12 h-12 mt-auto rounded-full bg-red-600 flex items-center justify-center text-white cursor-pointer hover:bg-red-700"
            title="Logout"
          >
            <FaSignOutAlt size={20} />
          </button>
        </div>
        <div className="w-72 bg-gray-800 flex flex-col">
          <div className="p-4 border-b border-gray-700 flex items-center justify-between">
            <h2 className="text-xl font-semibold">ChatApp</h2>
            <span className="text-gray-400 text-sm">@{username}</span>
          </div>
          <div className="p-3 border-b border-gray-700">
            <h4 className="font-semibold text-gray-400 text-xs mb-1 uppercase">
              JOIN/CREATE ROOM
            </h4>
            <div className="flex gap-2">
              <input
                type="text"
                className="flex-1 p-2 bg-gray-700 rounded text-sm"
                placeholder="Room name"
                value={roomInput}
                onChange={(e) => setRoomInput(e.target.value)}
                onKeyPress={(e) => e.key === "Enter" && joinOrCreateRoom()}
              />
              <button
                className="bg-blue-600 p-2 rounded hover:bg-blue-700"
                onClick={joinOrCreateRoom}
                title="Join or Create Room"
              >
                <FaPlus size={14} />
              </button>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto custom-scrollbar">
            <div className="p-3 border-b border-gray-700">
              <h4 className="font-semibold text-gray-400 text-xs mb-1 uppercase flex items-center">
                <FaUsers className="mr-2" />
                ONLINE
              </h4>
              <ul className="text-sm">
                {onlineUsers.length > 0 ? (
                  onlineUsers.map((userObj, i) => (
                    <li
                      key={`online-${userObj.id}`}
                      onClick={() => startChatWith(userObj)}
                      title={`Chat with ${userObj.username}`}
                      className={`p-1.5 rounded cursor-pointer flex items-center truncate ${
                        activeChatType === "dm" && userObj === activeChat
                          ? "bg-gray-700 font-semibold"
                          : "hover:bg-gray-600"
                      } ${
                        userObj === username ? "text-blue-400" : "text-gray-300"
                      }`}
                    >
                      <span
                        className={`w-2 h-2 rounded-full mr-2 shrink-0 ${
                          userObj.username === username
                            ? "bg-blue-400"
                            : "bg-green-500"
                        }`}
                      ></span>
                      <span className="truncate">
                        {userObj.username}
                        {userObj.username === username && " (You)"}
                      </span>
                    </li>
                  ))
                ) : (
                  <li className="text-gray-500 text-xs p-1.5">
                    No users online
                  </li>
                )}
              </ul>
            </div>
            <div className="p-3 border-b border-gray-700">
              <h4 className="font-semibold text-gray-400 text-xs mb-1 uppercase flex items-center">
                <FaCommentDots className="mr-2" />
                MESSAGES
              </h4>
              <ul className="text-sm">
                {activeConversations.length > 0 ? (
                  activeConversations.map((convoObj, i) => {
                    const otherUser = getOtherUserName(convoObj);
                    const dmChatId = [username, otherUser].sort().join("_");
                    const unread = unreadCounts[dmChatId] || 0;

                    return (
                      <li
                        key={`dm-${convoObj.id}`}
                        onClick={() => startChatWith(convoObj)}
                        title={`Chat with ${otherUser}`}
                        className={`flex justify-between items-center p-1.5 rounded cursor-pointer truncate ${
                          activeChatType === "dm" &&
                          activeChat?.id === convoObj.id
                            ? "bg-gray-700 font-semibold"
                            : "hover:bg-gray-600 text-gray-300"
                        }`}
                      >
                        <span className="truncate">@{otherUser}</span>
                        {unread > 0 && (
                          <span className="bg-red-600 text-xs rounded-full px-1.5 py-0.5 font-bold ml-1 shrink-0">
                            {unread}
                          </span>
                        )}
                      </li>
                    );
                  })
                ) : (
                  <li className="text-gray-500 text-xs p-1.5">
                    No direct messages yet.
                  </li>
                )}
              </ul>
            </div>
            <div className="p-3 border-b border-gray-700">
              <h4 className="font-semibold text-gray-400 text-xs mb-1 uppercase flex items-center">
                <FaHashtag className="mr-2" />
                YOUR JOINED ROOMS
              </h4>
              <ul className="text-sm">
                {userJoinedRooms.length > 0 ? (
                  userJoinedRooms.map((roomName, i) => {
                    const unread = unreadCounts[roomName] || 0;
                    const roomDetails = availableRooms.find(
                      (r) => r.name === roomName
                    );
                    const onlineCountInJoinedRoom = roomDetails
                      ? roomDetails.online_count
                      : 0;
                    return (
                      <li
                        key={`joined-${i}-${roomName}`}
                        className={`flex justify-between items-center p-1.5 rounded group ${
                          activeChatType === "room" && roomName === activeChat
                            ? "bg-gray-700 font-semibold"
                            : "hover:bg-gray-600"
                        }`}
                      >
                        <span
                          onClick={() =>
                            establishChatConnection(roomName, "room")
                          }
                          title={`Open room ${roomName}`}
                          className="cursor-pointer flex-1 truncate text-gray-300 group-hover:text-white"
                        >
                          #{roomName}
                        </span>
                        <div className="flex items-center shrink-0 ml-1">
                          {unread > 0 && (
                            <span className="bg-red-600 text-xs rounded-full px-1.5 py-0.5 font-bold mr-1.5">
                              {unread}
                            </span>
                          )}
                          <span
                            className={`text-xs px-1.5 py-0.5 rounded-full font-medium mr-1.5 ${
                              onlineCountInJoinedRoom > 0
                                ? "bg-green-600 text-white"
                                : "bg-gray-600 text-gray-400"
                            }`}
                          >
                            {onlineCountInJoinedRoom}
                          </span>
                          {activeChat === roomName &&
                            activeChatType === "room" && (
                              <button
                                onClick={() => leaveRoom(roomName)}
                                className="text-red-500 hover:text-red-400 opacity-75 group-hover:opacity-100"
                                title="Leave Room"
                              >
                                <FaSignOutAlt size={12} />
                              </button>
                            )}
                        </div>
                      </li>
                    );
                  })
                ) : (
                  <li className="text-gray-500 text-xs p-1.5">
                    No rooms joined yet.
                  </li>
                )}
              </ul>
            </div>
            <div className="p-3">
              <h4 className="font-semibold text-gray-400 text-xs mb-1 uppercase flex items-center">
                <FaHashtag className="mr-2" />
                PUBLIC ROOMS
              </h4>
              <ul className="text-sm">
                {availableRooms.length > 0 ? (
                  availableRooms.map((room, i) => {
                    const isJoined = userJoinedRooms.includes(room.name);
                    return (
                      <li
                        key={`avail-${i}-${room.name}`}
                        onClick={() =>
                          establishChatConnection(room.name, "room")
                        }
                        title={`Join room ${room.name}`}
                        className={`flex justify-between items-center p-1.5 rounded cursor-pointer truncate ${
                          activeChatType === "room" && room.name === activeChat
                            ? "bg-gray-700 font-semibold"
                            : "hover:bg-gray-600 text-gray-300"
                        }`}
                      >
                        <span className="truncate">#{room.name}</span>
                        <div className="flex items-center shrink-0 ml-1">
                          {isJoined && (
                            <span className="text-xs text-blue-400 mr-1.5">
                              (Joined)
                            </span>
                          )}
                          <span
                            className={`text-xs px-1.5 py-0.5 rounded-full font-medium ${
                              room.online_count > 0
                                ? "bg-green-600 text-white"
                                : "bg-gray-600 text-gray-400"
                            }`}
                          >
                            {room.online_count}
                          </span>
                        </div>
                      </li>
                    );
                  })
                ) : (
                  <li className="text-gray-500 text-xs p-1.5">
                    No public rooms available.
                  </li>
                )}
              </ul>
            </div>
          </div>
        </div>
        <div className="flex-1 bg-gray-700 flex flex-col">
          {!activeChat ? (
            <div className="flex items-center justify-center h-full text-gray-400 text-lg">
              Select a chat or room to begin.
            </div>
          ) : (
            <>
              <div className="p-4 border-b border-gray-600 bg-gray-800 flex items-center">
                <span className="text-xl font-semibold mr-2">
                  {activeChatType === "dm"
                    ? `@${(activeChat.username)}`
                    : `#${activeChat}`}
                </span>
                <span className="text-gray-400 text-sm">
                  ({activeChatType === "dm" ? "Direct Message" : "Chat Room"})
                </span>
              </div>
              <div
                ref={chatContainerRef}
                onScroll={handleScroll}
                className="flex-1 overflow-y-auto p-4 space-y-4 custom-scrollbar"
              >
                {messageHistory[currentChatId]?.loading && (
                  <div className="text-center p-2 text-gray-400">
                    Loading older messages...
                  </div>
                )}
                {currentMessages.map((msg, i) => (
                  <div
                    key={msg.id}
                    className={`flex ${
                      msg.sender.username === username ? "justify-end" : "justify-start"
                    }`}
                  >
                    <div
                      className={`max-w-xl p-3 rounded-lg shadow ${
                        msg.sender.username === username
                          ? "bg-blue-600 text-white"
                          : "bg-gray-600 text-gray-200"
                      }`}
                    >
                      <div className="flex items-center mb-1">
                        <strong className="text-sm mr-2">
                          {msg.sender.username === username ? "You" : msg.sender.username}
                        </strong>
                        <span className="text-xs text-gray-400 mr-2">
                          {formatTimestamp(msg.timestamp)}
                        </span>
                        {msg.sender.username === username && activeChatType === "dm" && (
                          <span className="text-xs ml-1">
                            {msg.is_read ? (
                              <FaCheckDouble className="text-sky-300" />
                            ) : (
                              <FaCheck className="text-gray-400" />
                            )}
                          </span>
                        )}
                      </div>
                      {msg.message_type === "image" && msg.image_content ? (
                        <img
                          src={msg.image_content}
                          alt="uploaded content"
                          className="max-w-xs sm:max-w-sm md:max-w-md max-h-72 rounded mt-1 cursor-pointer"
                          onClick={() => window.open(msg.image_content, "_blank")}
                        />
                      ) : (
                        <p className="text-base break-words">{msg.message}</p>
                      )}
                    </div>
                  </div>
                ))}
                <div ref={messagesEndRef} />
              </div>
              <div className="p-4 bg-gray-800 border-t border-gray-600 flex items-center gap-3">
                <label
                  className="cursor-pointer text-gray-400 hover:text-gray-200"
                  title="Upload Image"
                >
                  <FaImage size={24} />
                  <input
                    type="file"
                    accept="image/*"
                    onChange={handleImageUpload}
                    className="hidden"
                  />
                </label>
                <input
                  type="text"
                  className="flex-1 p-3 bg-gray-700 text-gray-100 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder-gray-500"
                  placeholder={`Message ${
                    activeChatType === "dm"
                      ? `@${activeChat.username}`
                      : `#${activeChat}`
                  }`}
                  value={messageInput}
                  onChange={(e) => setMessageInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      sendChatMessage();
                    }
                  }}
                />
                <button
                  className="bg-blue-600 text-white p-3 rounded-lg hover:bg-blue-700 flex items-center justify-center"
                  onClick={sendChatMessage}
                  title="Send Message"
                >
                  <FaPaperPlane size={20} />
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    );
  };

  // --- Main Render Logic ---
  if (view === "loading")
    return (
      <div className="flex items-center justify-center h-screen bg-gray-900 text-white">
        Loading session...
      </div>
    );
  if (view === "login") return renderLogin();
  if (view === "signup") return renderSignup();
  if (view === "chat" && username) return renderChat();

  console.warn(`Render Fallback: View='${view}', Username='${username}'`);
  if (view === "chat" && !username && authTokens) {
    const decoded = jwtDecode(authTokens.access);
    if (decoded?.username) {
      setUsername(decoded.username);
      return (
        <div className="flex items-center justify-center h-screen bg-gray-900 text-white">
          Restoring session...
        </div>
      );
    }
  }
  if (authTokens && (!userPayload || userPayload.exp * 1000 <= Date.now())) {
    logoutUser();
    return (
      <div className="flex items-center justify-center h-screen bg-gray-900 text-white">
        Session expired. Logging out...
      </div>
    );
  }
  if (!authTokens && view !== "login" && view !== "signup") {
    logoutUser();
    return (
      <div className="flex items-center justify-center h-screen bg-gray-900 text-white">
        Redirecting to login...
      </div>
    );
  }
  return (
    <div className="flex items-center justify-center h-screen bg-gray-900 text-white">
      An unexpected error occurred. Please try logging in.
    </div>
  );
}
