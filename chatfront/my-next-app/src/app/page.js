// src/app/page.js - FINAL, COMPLETE, AND CORRECTED VERSION
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
const API_BASE_URL = "http://192.168.68.110:8000/api";
const WEBSOCKET_HOST = "192.168.68.110:8000";

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
    if (!userPayload || !activeChat || !activeChatType) return null;

    if (activeChatType === "dm") {
      const user_ids = [userPayload.user_id, activeChat.id].sort(
        (a, b) => a - b
      );
      return `dm_${user_ids[0]}_${user_ids[1]}`;
    }
    if (activeChatType === "room") {
      return activeChat;
    }
    return null;
  }, [userPayload, activeChat, activeChatType]);

  const showNotification = (title, body, tag) => {
    if (Notification.permission === "granted") {
      const notification = new Notification(title, { body: body, tag: tag });
      notification.onclick = () => window.focus();
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

  const markMessagesAsReadOnServer = useCallback((chatId, messageIds) => {
    const targetSocket = chatWs.current[chatId];
    if (
      targetSocket &&
      targetSocket.readyState === WebSocket.OPEN &&
      messageIds &&
      messageIds.length > 0
    ) {
      targetSocket.send(
        JSON.stringify({ type: "mark_read_batch", message_ids: messageIds })
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
          const user_ids = [
            messageData.sender.id,
            messageData.receiver.id,
          ].sort((a, b) => a - b);
          messageOriginChatId = `dm_${user_ids[0]}_${user_ids[1]}`;
        } else {
          messageOriginChatId = messageData.room_name;
        }

        setMessages((prev) => {
          const existingMsgs = prev[messageOriginChatId] || [];
          const updatedMessages = [...existingMsgs, messageData];
          const uniqueMessages = Array.from(
            new Map(updatedMessages.map((item) => [item.id, item])).values()
          );
          const sortedMessages = [...uniqueMessages].sort(
            (a, b) => new Date(a.timestamp) - new Date(b.timestamp)
          );
          return { ...prev, [messageOriginChatId]: sortedMessages };
        });

        if (username && messageData.sender.username !== username) {
          if (document.hidden || messageOriginChatId !== currentChatId) {
            setUnreadCounts((prev) => ({
              ...prev,
              [messageOriginChatId]: (prev[messageOriginChatId] || 0) + 1,
            }));
            showNotification(
              `New message from ${messageData.sender.username}`,
              messageData.message || "Sent an image",
              messageOriginChatId
            );
          } else {
            markMessagesAsReadOnServer(messageOriginChatId, [messageData.id]);
          }
        }
      } else if (data.type === "messages_marked_as_read") {
        const { room_name: receiptChatId, message_ids: readMessageIds } = data;

        setMessages((prevMessages) => {
          const currentChatMessages = prevMessages[receiptChatId] || [];
          if (currentChatMessages.length === 0) {
            return prevMessages;
          }
          const updatedMessagesForChat = currentChatMessages.map((msg) => {
            if (readMessageIds.includes(msg.id)) {
              return { ...msg, is_read: true };
            }
            return msg;
          });
          return {
            ...prevMessages,
            [receiptChatId]: updatedMessagesForChat,
          };
        });
      }
    },
    [username, getCurrentChatIdentifier, markMessagesAsReadOnServer]
  );

  const logoutUser = useCallback(async () => {
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

    setMessages({});
    setMessageHistory({});
    setUnreadCounts({});
    setActiveChat(null);
    setActiveChatType(null);
    setOnlineUsers([]);
    setAvailableRooms([]);
    setUserJoinedRooms([]);
    setActiveConversations([]);

    setAuthTokens(null);
    setUserPayload(null);
    setUsername("");
    localStorage.removeItem("authTokens");

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
        const decodedPayload = jwtDecode(newTokens.access);
        setAuthTokens(newTokens);
        setUserPayload(decodedPayload);
        localStorage.setItem("authTokens", JSON.stringify(newTokens));
        setUsername(decodedPayload.username);
        setView("chat");
      }
    } catch (error) {
      alert(error.response?.data?.detail || "Login failed!");
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
        await loginUser(currentRegUsername, currentRegPassword);
      }
    } catch (error) {
      alert("Registration failed! " + JSON.stringify(error.response?.data));
    }
  };

  const fetchUserInitialChats = useCallback(async (tokens) => {
    if (!tokens?.access) return;
    try {
      const response = await axios.get(`${API_BASE_URL}/user-chats/`, {
        headers: { Authorization: `Bearer ${tokens.access}` },
      });
      const { dms = [], rooms = [] } = response.data;
      setActiveConversations(dms);
      setUserJoinedRooms(rooms);
    } catch (error) {
      console.error("Failed to fetch user's initial chats:", error);
    }
  }, []);
  const loadInitialMessages = useCallback(
    async (chatId, chatType, receiverId) => {
      if (!authTokens) return;

      // This function ALWAYS fetches the first page of messages.
      // It does NOT check messageHistory, ensuring it always runs on chat open.

      setMessageHistory((prev) => ({
        ...prev,
        [chatId]: { ...prev[chatId], loading: true },
      }));

      const url = `${API_BASE_URL}/messages/?${
        chatType === "dm" ? `receiver_id=${receiverId}` : `room_name=${chatId}`
      }`;

      try {
        const response = await axios.get(url, {
          headers: { Authorization: `Bearer ${authTokens.access}` },
        });

        const { results, next } = response.data;
        const chronologicallyOrderedResults = results.slice().reverse();

        // Key Change: This REPLACES the messages for the chat, ensuring a clean slate.
        setMessages((prev) => ({
          ...prev,
          [chatId]: chronologicallyOrderedResults,
        }));

        // Now, set the history state for future pagination (scrolling).
        setMessageHistory((prev) => ({
          ...prev,
          [chatId]: { next: next, loading: false },
        }));
      } catch (error) {
        console.error("Failed to load initial messages:", error);
        setMessageHistory((prev) => ({
          ...prev,
          [chatId]: { ...prev[chatId], loading: false },
        }));
      }
    },
    [authTokens] // This function only depends on authTokens
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
        const chronologicallyOrderedResults = results.slice().reverse();

        setMessages((prev) => {
          const existingMessages = prev[chatId] || [];
          const updatedMessages = [
            ...chronologicallyOrderedResults,
            ...existingMessages,
          ];
          const uniqueMessages = Array.from(
            new Map(updatedMessages.map((item) => [item.id, item])).values()
          );
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

  const establishChatConnection = useCallback(
    async (target, type) => {
      if (!authTokens?.access || !userPayload) {
        logoutUser();
        return;
      }
      if (type === "dm" && username === target.username) {
        alert("You cannot chat with yourself!");
        return;
      }

      const token = authTokens.access;
      let chatIdentifier,
        wsUrl,
        receiverId = null;

      if (type === "dm") {
        receiverId = target.id;
        const user_ids = [userPayload.user_id, target.id].sort((a, b) => a - b);
        chatIdentifier = `dm_${user_ids[0]}_${user_ids[1]}`;
        setActiveConversations((prev) =>
          prev.some((dm) => dm.id === target.id) ? prev : [...prev, target]
        );
      } else {
        chatIdentifier = target;
        setUserJoinedRooms((prev) =>
          prev.includes(chatIdentifier) ? prev : [...prev, chatIdentifier]
        );
      }
      wsUrl = `ws://${WEBSOCKET_HOST}/ws/chat/${chatIdentifier}/?token=${token}`;

      setActiveChat(target);
      setActiveChatType(type);

      // --- THE FINAL FIX ---
      // Use our new, dedicated function to reliably load the initial chat history.
      loadInitialMessages(chatIdentifier, type, receiverId);
      // --- END OF FIX ---

      if (
        !chatWs.current[chatIdentifier] ||
        chatWs.current[chatIdentifier].readyState > 1
      ) {
        setChatConnecting((prev) => ({ ...prev, [chatIdentifier]: true }));
        const socket = new WebSocket(wsUrl);
        chatWs.current[chatIdentifier] = socket;

        socket.onopen = () => {
          console.log(
            `[Frontend] WS Connected: ${type} chat ${chatIdentifier}`
          );
          setChatConnecting((prev) => ({ ...prev, [chatIdentifier]: false }));
        };
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
      }
    },
    // Update the dependency array to include the new function
    [authTokens, userPayload, username, logoutUser, loadInitialMessages]
  );

  const sendMessage = useCallback(
    (messagePayload) => {
      const currentChatId = getCurrentChatIdentifier();
      if (!username || !currentChatId) return;

      const currentChatSocket = chatWs.current[currentChatId];
      if (currentChatSocket?.readyState === WebSocket.OPEN) {
        const payload = {
          ...messagePayload,
          type: "chat_message",
          sender: username,
          room_name: activeChatType === "room" ? activeChat : null,
          is_dm: activeChatType === "dm",
          receiver: activeChatType === "dm" ? activeChat.username : null,
        };
        currentChatSocket.send(JSON.stringify(payload));
      } else {
        alert("Chat connection is not open. Please try again.");
        console.error(
          `[SendMessage] FAILED: Socket state is ${currentChatSocket?.readyState}, not OPEN.`
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

  const leaveRoom = useCallback(async (roomToLeave) => {
    // Logic for leaving a room can be added here
  }, []);

  const startChatWith = useCallback(
    (targetUser) => {
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
    if (chatContainer) {
      const { scrollHeight, clientHeight, scrollTop } = chatContainer;
      if (scrollHeight - scrollTop < clientHeight + 200) {
        chatContainer.scrollTop = chatContainer.scrollHeight;
      }
    }
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
          setUsername(decoded.username);
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
      fetchUserInitialChats(authTokens).then(() => setView("chat"));
    }
  }, [username, authTokens, view, fetchUserInitialChats]);

  useEffect(() => {
    if (view !== "chat" || !authTokens) return;
    if (
      "Notification" in window &&
      Notification.permission !== "granted" &&
      Notification.permission !== "denied"
    ) {
      Notification.requestPermission();
    }
    const ws = new WebSocket(
      `ws://${WEBSOCKET_HOST}/ws/presence/?token=${authTokens.access}`
    );
    globalWs.current = ws;
    ws.onopen = () =>
      console.log(`Global presence WS connected for '${username}'.`);
    ws.onclose = () => console.log(`Global WS Disconnected for '${username}'.`);
    ws.onerror = (e) => console.error(`Global WS error for '${username}':`, e);
    ws.onmessage = (e) => {
      const data = JSON.parse(e.data);
      if (data.type === "user_list") setOnlineUsers(data.users);
      if (data.type === "detailed_room_list") setAvailableRooms(data.rooms);
    };
    return () => {
      ws.close();
    };
  }, [view, authTokens, username]);

  useEffect(() => {
    const currentChatId = getCurrentChatIdentifier();
    if (view === "chat" && currentChatId && username) {
      if (unreadCounts[currentChatId]) {
        setUnreadCounts((prev) => ({ ...prev, [currentChatId]: 0 }));
      }
      const chatMessages = messages[currentChatId] || [];
      const unreadIds = chatMessages
        .filter(
          (msg) => msg.sender.username !== username && !msg.is_read && msg.id
        )
        .map((msg) => msg.id);
      if (unreadIds.length > 0) {
        markMessagesAsReadOnServer(currentChatId, unreadIds);
      }
    }
  }, [
    messages,
    activeChat,
    activeChatType,
    view,
    username,
    getCurrentChatIdentifier,
    unreadCounts,
    markMessagesAsReadOnServer,
  ]);

  const handleScroll = useCallback(
    (e) => {
      if (e.target.scrollTop === 0) {
        const chatIdentifier = getCurrentChatIdentifier();
        if (!chatIdentifier) return;
        const receiverId = activeChatType === "dm" ? activeChat.id : null;
        fetchChatHistory(chatIdentifier, activeChatType, receiverId);
      }
    },
    [getCurrentChatIdentifier, activeChat, activeChatType, fetchChatHistory]
  );

  // --- Rendering ---
  if (view === "loading")
    return (
      <div className="flex items-center justify-center h-screen bg-gray-900 text-white">
        Loading...
      </div>
    );
  if (view === "login") return renderLogin();
  if (view === "signup") return renderSignup();
  if (view === "chat" && username) return renderChat();

  return (
    <div className="flex items-center justify-center h-screen bg-gray-900 text-white">
      An error occurred.
    </div>
  );

  function renderLogin() {
    return (
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
            autoComplete="username"
          />
          <input
            type="password"
            placeholder="Password"
            value={loginPassword}
            onChange={(e) => setLoginPassword(e.target.value)}
            className="w-full p-3 mb-6 bg-gray-700 text-white rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
            required
            autoComplete="current-password"
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
  }

  function renderSignup() {
    return (
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
            autoComplete="username"
          />
          <input
            type="email"
            placeholder="Email"
            value={regEmail}
            onChange={(e) => setRegEmail(e.target.value)}
            className="w-full p-3 mb-4 bg-gray-700 text-white rounded focus:outline-none focus:ring-2 focus:ring-green-500"
            required
            autoComplete="email"
          />
          <input
            type="password"
            placeholder="Password"
            value={regPassword}
            onChange={(e) => setRegPassword(e.target.value)}
            className="w-full p-3 mb-4 bg-gray-700 text-white rounded focus:outline-none focus:ring-2 focus:ring-green-500"
            required
            autoComplete="new-password"
          />
          <input
            type="password"
            placeholder="Confirm Password"
            value={regPassword2}
            onChange={(e) => setRegPassword2(e.target.value)}
            className="w-full p-3 mb-6 bg-gray-700 text-white rounded focus:outline-none focus:ring-2 focus:ring-green-500"
            required
            autoComplete="new-password"
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
  }

  function renderChat() {
    const currentChatId = getCurrentChatIdentifier();
    const isConnecting = currentChatId ? chatConnecting[currentChatId] : false;
    const currentMessages = currentChatId ? messages[currentChatId] || [] : [];

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
                  onlineUsers.map((userObj) => (
                    <li
                      key={`online-${userObj.id}`}
                      onClick={() => startChatWith(userObj)}
                      title={`Chat with ${userObj.username}`}
                      className={`p-1.5 rounded cursor-pointer flex items-center truncate ${
                        activeChatType === "dm" && activeChat?.id === userObj.id
                          ? "bg-gray-700 font-semibold"
                          : "hover:bg-gray-600"
                      } ${
                        userObj.username === username
                          ? "text-blue-400"
                          : "text-gray-300"
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
                  activeConversations.map((convoObj) => {
                    if (!userPayload) return null;
                    const otherUser = getOtherUserName(convoObj);
                    const user_ids = [userPayload.user_id, convoObj.id].sort(
                      (a, b) => a - b
                    );
                    const dmChatId = `dm_${user_ids[0]}_${user_ids[1]}`;
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
                    const onlineCount =
                      availableRooms.find((r) => r.name === roomName)
                        ?.online_count || 0;
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
                              onlineCount > 0
                                ? "bg-green-600 text-white"
                                : "bg-gray-600 text-gray-400"
                            }`}
                          >
                            {onlineCount}
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
                  availableRooms.map((room, i) => (
                    <li
                      key={`avail-${i}-${room.name}`}
                      onClick={() => establishChatConnection(room.name, "room")}
                      title={`Join room ${room.name}`}
                      className={`flex justify-between items-center p-1.5 rounded cursor-pointer truncate ${
                        activeChatType === "room" && room.name === activeChat
                          ? "bg-gray-700 font-semibold"
                          : "hover:bg-gray-600 text-gray-300"
                      }`}
                    >
                      <span className="truncate">#{room.name}</span>
                      <span
                        className={`text-xs px-1.5 py-0.5 rounded-full font-medium ${
                          room.online_count > 0
                            ? "bg-green-600 text-white"
                            : "bg-gray-600 text-gray-400"
                        }`}
                      >
                        {room.online_count}
                      </span>
                    </li>
                  ))
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
                    ? `@${activeChat.username}`
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
                    key={msg.id || `msg-${i}`}
                    className={`flex ${
                      msg.sender.username === username
                        ? "justify-end"
                        : "justify-start"
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
                          {msg.sender.username === username
                            ? "You"
                            : msg.sender.username}
                        </strong>
                        <span className="text-xs text-gray-400 mr-2">
                          {formatTimestamp(msg.timestamp)}
                        </span>
                        {msg.sender.username === username &&
                          activeChatType === "dm" && (
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
                          alt="uploaded"
                          className="max-w-xs sm:max-w-sm md:max-w-md max-h-72 rounded mt-1 cursor-pointer"
                          onClick={() =>
                            window.open(msg.image_content, "_blank")
                          }
                        />
                      ) : (
                        <p className="text-base break-words">{msg.message}</p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
              <div className="p-4 bg-gray-800 border-t border-gray-600 flex items-center gap-3">
                <label
                  className={`cursor-pointer text-gray-400 ${
                    isConnecting ? "opacity-50" : "hover:text-gray-200"
                  }`}
                  title="Upload Image"
                >
                  <FaImage size={24} />
                  <input
                    type="file"
                    accept="image/*"
                    onChange={handleImageUpload}
                    className="hidden"
                    disabled={isConnecting}
                  />
                </label>
                <input
                  type="text"
                  className="flex-1 p-3 bg-gray-700 text-gray-100 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder-gray-500"
                  placeholder={
                    isConnecting
                      ? "Connecting..."
                      : `Message ${
                          activeChatType === "dm"
                            ? `@${activeChat.username}`
                            : `#${activeChat}`
                        }`
                  }
                  value={messageInput}
                  onChange={(e) => setMessageInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      sendChatMessage();
                    }
                  }}
                  disabled={isConnecting}
                />
                <button
                  className="bg-blue-600 text-white p-3 rounded-lg hover:bg-blue-700 flex items-center justify-center"
                  onClick={sendChatMessage}
                  title="Send Message"
                  disabled={isConnecting}
                >
                  <FaPaperPlane size={20} />
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    );
  }
}
