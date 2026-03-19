/**
 * T&S Operational Chat - Client-side Module
 * Initializes on any element with data-chat-thread attribute.
 */
(function () {
  'use strict';

  const POLL_ACTIVE = 5000;   // 5s when chat visible
  const POLL_BACKGROUND = 30000; // 30s when hidden
  const BADGE_POLL = 30000;   // 30s for unread badge

  // CSRF token helper (required for all POST requests)
  function getCsrfToken() {
    const meta = document.querySelector('meta[name="csrf-token"]');
    return meta ? meta.getAttribute('content') : '';
  }

  // ============================================
  // Chat Panel Controller
  // ============================================
  class ChatPanel {
    constructor(container) {
      this.container = container;
      this.threadId = container.dataset.chatThread;
      this.currentUserId = parseInt(container.dataset.currentUserId);
      this.currentUserName = container.dataset.currentUserName;
      this.lastMessageId = 0;
      this.pollTimer = null;
      this.isVisible = true;
      this.replyToId = null;
      this.replyToText = '';
      this.mentionedUserIds = [];
      this.members = [];
      this.mentionDropdownActive = false;
      this.mentionQuery = '';
      this.mentionStartPos = -1;

      this.messagesEl = container.querySelector('.chat-messages');
      this.inputEl = container.querySelector('.chat-input');
      this.sendBtn = container.querySelector('.chat-send');
      this.imageInput = container.querySelector('.chat-image-input');
      this.replyIndicator = container.querySelector('.chat-reply-indicator');
      this.replyText = container.querySelector('.chat-reply-text');
      this.replyCancel = container.querySelector('.chat-reply-cancel');
      this.mentionDropdown = container.querySelector('.chat-mention-dropdown');

      this.init();
    }

    init() {
      // Load initial messages
      this.loadMessages();
      // Load members for @mention
      this.loadMembers();
      // Start polling
      this.startPolling();

      // Event listeners
      this.sendBtn.addEventListener('click', () => this.sendMessage());
      this.inputEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          if (this.mentionDropdownActive) {
            this.selectMention();
          } else {
            this.sendMessage();
          }
        }
        if (e.key === 'Escape' && this.mentionDropdownActive) {
          this.closeMentionDropdown();
        }
        if (e.key === 'ArrowDown' && this.mentionDropdownActive) {
          e.preventDefault();
          this.navigateMention(1);
        }
        if (e.key === 'ArrowUp' && this.mentionDropdownActive) {
          e.preventDefault();
          this.navigateMention(-1);
        }
      });
      this.inputEl.addEventListener('input', () => this.handleMentionInput());

      // Auto-resize textarea
      this.inputEl.addEventListener('input', () => {
        this.inputEl.style.height = 'auto';
        this.inputEl.style.height = Math.min(this.inputEl.scrollHeight, 120) + 'px';
      });

      if (this.imageInput) {
        this.imageInput.addEventListener('change', (e) => {
          if (e.target.files[0]) this.uploadImage(e.target.files[0]);
        });
      }

      if (this.replyCancel) {
        this.replyCancel.addEventListener('click', () => this.cancelReply());
      }

      // Visibility tracking
      document.addEventListener('visibilitychange', () => {
        this.isVisible = !document.hidden;
        this.restartPolling();
      });

      // Mark as read when scrolled to bottom
      this.messagesEl.addEventListener('scroll', () => {
        if (this.isScrolledToBottom()) {
          this.markAsRead();
        }
      });
    }

    async loadMessages() {
      try {
        const resp = await fetch(`/chat/api/threads/${this.threadId}/messages?after=${this.lastMessageId}`);
        if (!resp.ok) return;
        const data = await resp.json();
        if (data.messages && data.messages.length > 0) {
          const wasAtBottom = this.isScrolledToBottom();

          // Remove loading placeholder if first load
          if (this.lastMessageId === 0) {
            this.messagesEl.innerHTML = '';
          }

          for (const msg of data.messages) {
            this.renderMessage(msg);
            this.lastMessageId = msg.id;
          }

          if (wasAtBottom || this.lastMessageId === 0) {
            this.scrollToBottom();
            this.markAsRead();
          }
        } else if (this.lastMessageId === 0) {
          this.messagesEl.innerHTML = '<div class="text-center text-slate-500 text-sm py-8">No messages yet. Start the conversation.</div>';
        }
      } catch (err) {
        console.error('Chat load error:', err);
      }
    }

    renderMessage(msg) {
      const div = document.createElement('div');
      const isOwn = msg.sender_id === this.currentUserId;
      const isSystem = msg.message_type === 'system';

      if (isSystem) {
        div.className = 'chat-msg chat-msg-system';
        div.innerHTML = `<div class="chat-msg-bubble">${this.escapeHtml(msg.body)}</div>`;
      } else {
        div.className = `chat-msg ${isOwn ? 'chat-msg-own' : ''}`;
        div.dataset.msgId = msg.id;

        const initials = (msg.sender_name || '?').split(' ').map(w => w[0]).join('').substring(0, 2).toUpperCase();
        const avatarColor = this.getAvatarColor(msg.sender_id);

        let replyHtml = '';
        if (msg.reply_to_message_id && msg.reply_to_body) {
          replyHtml = `<div class="chat-msg-reply"><strong>${this.escapeHtml(msg.reply_to_sender_name || 'Unknown')}</strong>: ${this.escapeHtml(msg.reply_to_body).substring(0, 80)}</div>`;
        }

        let bodyHtml = this.formatMessageBody(msg.body);

        let attachmentHtml = '';
        if (msg.attachments && msg.attachments.length > 0) {
          for (const att of msg.attachments) {
            if (att.mime_type && att.mime_type.startsWith('image/')) {
              attachmentHtml += `<img src="${this.escapeHtml(att.thumbnail_url || att.file_url)}" data-full="${this.escapeHtml(att.file_url)}" class="chat-msg-image" alt="${this.escapeHtml(att.original_name)}" onclick="window._chatLightbox(this.dataset.full)">`;
            } else {
              const sizeKb = att.file_size ? Math.round(att.file_size / 1024) : 0;
              const ext = att.original_name ? att.original_name.split('.').pop().toUpperCase() : 'FILE';
              attachmentHtml += `<a href="${this.escapeHtml(att.file_url)}" target="_blank" class="flex items-center gap-2 mt-1 px-3 py-2 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors text-xs" style="max-width:250px">
                <svg class="w-4 h-4 text-gray-500 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>
                <span class="truncate text-gray-700 font-medium">${this.escapeHtml(att.original_name || 'File')}</span>
                <span class="text-gray-400 flex-shrink-0">${ext} · ${sizeKb}KB</span>
              </a>`;
            }
          }
        }

        const timeStr = this.formatTime(msg.created_at);

        let actionsHtml = '';
        if (isOwn) {
          actionsHtml = `<div class="chat-msg-actions"><button class="text-slate-600 hover:text-red-400 text-xs px-1" onclick="window._chatDeleteMsg(${msg.id}, ${this.threadId})" title="Delete">&times;</button></div>`;
        }

        div.innerHTML = `
          <div class="chat-msg-avatar" style="background:${avatarColor}">${initials}</div>
          <div style="max-width:75%">
            ${!isOwn ? `<div class="chat-msg-sender" style="color:${avatarColor}">${this.escapeHtml(msg.sender_name || 'Unknown')}</div>` : ''}
            ${replyHtml}
            <div class="chat-msg-bubble">${bodyHtml}${attachmentHtml}</div>
            <div class="chat-msg-time">${timeStr}</div>
          </div>
          ${actionsHtml}
          <button class="chat-reply-btn text-slate-600 hover:text-slate-300 text-xs self-center" onclick="window._chatReply(${msg.id}, '${this.escapeHtml(msg.sender_name || '')}', '${this.escapeHtml((msg.body || '').substring(0, 50))}', '${this.threadId}')" title="Reply" style="opacity:0;transition:opacity 0.15s">&#8617;</button>
        `;

        // Show reply button on hover
        div.addEventListener('mouseenter', () => {
          const btn = div.querySelector('.chat-reply-btn');
          if (btn) btn.style.opacity = '1';
        });
        div.addEventListener('mouseleave', () => {
          const btn = div.querySelector('.chat-reply-btn');
          if (btn) btn.style.opacity = '0';
        });
      }

      this.messagesEl.appendChild(div);
    }

    formatMessageBody(body) {
      if (!body) return '';
      let html = this.escapeHtml(body);
      // Highlight @mentions
      html = html.replace(/@([A-Za-z\s]+?)(?=\s@|\s*$|[,.\-!?;:])/g, '<span class="chat-mention">@$1</span>');
      // Convert newlines
      html = html.replace(/\n/g, '<br>');
      return html;
    }

    formatTime(isoStr) {
      if (!isoStr) return '';
      const d = new Date(isoStr + (isoStr.endsWith('Z') ? '' : 'Z'));
      const now = new Date();
      const diffMs = now - d;
      const diffMin = Math.floor(diffMs / 60000);
      const diffHr = Math.floor(diffMs / 3600000);

      if (diffMin < 1) return 'just now';
      if (diffMin < 60) return `${diffMin}m ago`;
      if (diffHr < 24) return `${diffHr}h ago`;

      return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    }

    getAvatarColor(userId) {
      const colors = ['#6366f1', '#8b5cf6', '#06b6d4', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#14b8a6'];
      return colors[(userId || 0) % colors.length];
    }

    escapeHtml(str) {
      if (!str) return '';
      const d = document.createElement('div');
      d.textContent = str;
      return d.innerHTML;
    }

    isScrolledToBottom() {
      const el = this.messagesEl;
      return el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    }

    scrollToBottom() {
      this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
    }

    async sendMessage() {
      const body = this.inputEl.value.trim();
      if (!body) return;

      const payload = {
        body,
        message_type: 'text',
        reply_to_message_id: this.replyToId || null,
        mentioned_user_ids: [...this.mentionedUserIds]
      };

      // Optimistic: clear input immediately
      this.inputEl.value = '';
      this.inputEl.style.height = 'auto';
      this.cancelReply();
      this.mentionedUserIds = [];

      try {
        const resp = await fetch(`/chat/api/threads/${this.threadId}/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-csrf-token': getCsrfToken() },
          body: JSON.stringify(payload)
        });
        if (!resp.ok) {
          const err = await resp.json();
          console.error('Send failed:', err);
          return;
        }
        const data = await resp.json();
        if (data.message) {
          this.renderMessage(data.message);
          this.lastMessageId = data.message.id;
          this.scrollToBottom();
          this.markAsRead();
        }
      } catch (err) {
        console.error('Send error:', err);
      }
    }

    async uploadImage(file) {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('thread_id', this.threadId);

      try {
        const resp = await fetch('/chat/api/upload', { method: 'POST', headers: { 'x-csrf-token': getCsrfToken() }, body: formData });
        if (!resp.ok) {
          console.error('Upload failed');
          return;
        }
        const attachment = await resp.json();
        const isImage = attachment.mime_type && attachment.mime_type.startsWith('image/');

        // Send file message
        const payload = {
          body: isImage ? '' : attachment.original_name,
          message_type: isImage ? 'image' : 'file',
          reply_to_message_id: null,
          mentioned_user_ids: [],
          attachment
        };

        const msgResp = await fetch(`/chat/api/threads/${this.threadId}/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-csrf-token': getCsrfToken() },
          body: JSON.stringify(payload)
        });
        if (msgResp.ok) {
          const data = await msgResp.json();
          if (data.message) {
            this.renderMessage(data.message);
            this.lastMessageId = data.message.id;
            this.scrollToBottom();
            this.markAsRead();
          }
        }
      } catch (err) {
        console.error('Upload error:', err);
      }

      // Clear file input
      this.imageInput.value = '';
    }

    setReply(msgId, senderName, preview) {
      this.replyToId = msgId;
      this.replyText.textContent = `Replying to ${senderName}: ${preview}`;
      this.replyIndicator.classList.remove('hidden');
      this.inputEl.focus();
    }

    cancelReply() {
      this.replyToId = null;
      if (this.replyIndicator) this.replyIndicator.classList.add('hidden');
    }

    async markAsRead() {
      try {
        await fetch(`/chat/api/threads/${this.threadId}/read`, { method: 'POST', headers: { 'x-csrf-token': getCsrfToken() } });
      } catch (e) { /* ignore */ }
    }

    // ============================================
    // @Mention Autocomplete
    // ============================================
    async loadMembers() {
      try {
        const resp = await fetch(`/chat/api/threads/${this.threadId}/members`);
        if (resp.ok) {
          const data = await resp.json();
          this.members = data.members || [];
        }
      } catch (e) { /* ignore */ }
    }

    handleMentionInput() {
      const val = this.inputEl.value;
      const cursorPos = this.inputEl.selectionStart;

      // Find the last @ before cursor
      const beforeCursor = val.substring(0, cursorPos);
      const atIndex = beforeCursor.lastIndexOf('@');

      if (atIndex >= 0 && (atIndex === 0 || /\s/.test(val[atIndex - 1]))) {
        const query = beforeCursor.substring(atIndex + 1).toLowerCase();
        if (query.length >= 0 && !/\s{2}/.test(query)) {
          this.mentionStartPos = atIndex;
          this.mentionQuery = query;
          this.showMentionDropdown(query);
          return;
        }
      }
      this.closeMentionDropdown();
    }

    showMentionDropdown(query) {
      const filtered = this.members.filter(m =>
        m.full_name.toLowerCase().includes(query) && m.id !== this.currentUserId
      ).slice(0, 6);

      if (filtered.length === 0) {
        this.closeMentionDropdown();
        return;
      }

      this.mentionDropdown.innerHTML = filtered.map((m, i) =>
        `<div class="chat-mention-item ${i === 0 ? 'active' : ''}" data-user-id="${m.id}" data-name="${this.escapeHtml(m.full_name)}">${this.escapeHtml(m.full_name)} <span class="text-slate-500 text-xs">${m.role}</span></div>`
      ).join('');

      this.mentionDropdown.classList.remove('hidden');
      this.mentionDropdownActive = true;

      // Click handler for items
      this.mentionDropdown.querySelectorAll('.chat-mention-item').forEach(item => {
        item.addEventListener('mousedown', (e) => {
          e.preventDefault();
          const userId = parseInt(item.dataset.userId);
          const name = item.dataset.name;
          this.insertMention(userId, name);
        });
      });
    }

    closeMentionDropdown() {
      this.mentionDropdown.classList.add('hidden');
      this.mentionDropdownActive = false;
    }

    navigateMention(dir) {
      const items = this.mentionDropdown.querySelectorAll('.chat-mention-item');
      if (items.length === 0) return;
      let activeIndex = -1;
      items.forEach((item, i) => { if (item.classList.contains('active')) activeIndex = i; });
      items.forEach(item => item.classList.remove('active'));
      let newIndex = activeIndex + dir;
      if (newIndex < 0) newIndex = items.length - 1;
      if (newIndex >= items.length) newIndex = 0;
      items[newIndex].classList.add('active');
    }

    selectMention() {
      const active = this.mentionDropdown.querySelector('.chat-mention-item.active');
      if (active) {
        this.insertMention(parseInt(active.dataset.userId), active.dataset.name);
      }
    }

    insertMention(userId, name) {
      const val = this.inputEl.value;
      const before = val.substring(0, this.mentionStartPos);
      const after = val.substring(this.inputEl.selectionStart);
      this.inputEl.value = before + '@' + name + ' ' + after;
      this.inputEl.selectionStart = this.inputEl.selectionEnd = before.length + name.length + 2;
      this.closeMentionDropdown();
      this.inputEl.focus();

      if (!this.mentionedUserIds.includes(userId)) {
        this.mentionedUserIds.push(userId);
      }
    }

    // ============================================
    // Polling
    // ============================================
    startPolling() {
      this.stopPolling();
      const interval = this.isVisible ? POLL_ACTIVE : POLL_BACKGROUND;
      this.pollTimer = setInterval(() => this.loadMessages(), interval);
    }

    stopPolling() {
      if (this.pollTimer) {
        clearInterval(this.pollTimer);
        this.pollTimer = null;
      }
    }

    restartPolling() {
      this.startPolling();
    }
  }

  // ============================================
  // Global helpers (callable from onclick)
  // ============================================
  const panels = {};

  window._chatReply = function (msgId, senderName, preview, threadId) {
    if (panels[threadId]) {
      panels[threadId].setReply(msgId, senderName, preview);
    }
  };

  window._chatDeleteMsg = async function (msgId, threadId) {
    if (!confirm('Delete this message?')) return;
    try {
      const resp = await fetch(`/chat/api/threads/${threadId}/messages/${msgId}/delete`, { method: 'POST', headers: { 'x-csrf-token': getCsrfToken() } });
      if (resp.ok) {
        const el = document.querySelector(`[data-msg-id="${msgId}"]`);
        if (el) {
          el.style.opacity = '0.3';
          el.innerHTML = '<div class="chat-msg-bubble" style="font-style:italic;color:#64748b;font-size:0.75rem">Message deleted</div>';
        }
      }
    } catch (e) { console.error('Delete error:', e); }
  };

  window._chatLightbox = function (src) {
    const overlay = document.createElement('div');
    overlay.className = 'chat-lightbox';
    overlay.innerHTML = `<img src="${src}" alt="Full size">`;
    overlay.addEventListener('click', () => overlay.remove());
    document.body.appendChild(overlay);
  };

  // ============================================
  // Initialize all chat panels on page
  // ============================================
  function initChatPanels() {
    document.querySelectorAll('[data-chat-thread]').forEach(container => {
      const threadId = container.dataset.chatThread;
      if (!panels[threadId]) {
        panels[threadId] = new ChatPanel(container);
      }
    });
  }

  // ============================================
  // Global unread badge polling
  // ============================================
  function startBadgePolling() {
    setInterval(async () => {
      try {
        const resp = await fetch('/chat/api/unread-count');
        if (!resp.ok) return;
        const data = await resp.json();
        const badges = document.querySelectorAll('.chat-unread-badge');
        badges.forEach(badge => {
          if (data.count > 0) {
            badge.textContent = data.count > 99 ? '99+' : data.count;
            badge.classList.remove('hidden');
          } else {
            badge.classList.add('hidden');
          }
        });
      } catch (e) { /* ignore */ }
    }, BADGE_POLL);
  }

  // ============================================
  // Boot
  // ============================================
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      initChatPanels();
      startBadgePolling();
    });
  } else {
    initChatPanels();
    startBadgePolling();
  }

  // Also re-init when tabs switch (for job detail page)
  document.addEventListener('click', (e) => {
    if (e.target.matches('[onclick*="activateTab"]') || e.target.closest('[href="#chat"]')) {
      setTimeout(initChatPanels, 100);
    }
  });
})();
