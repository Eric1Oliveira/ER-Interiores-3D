// =============================================
// ER Interiores 3D — Supabase Integration
// =============================================

// --- SUPABASE CONFIG ---
const SUPABASE_URL = 'https://ktqhqjtfzhkcycpysuwt.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imt0cWhxanRmemhrY3ljcHlzdXd0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMwMDY2NDUsImV4cCI6MjA4ODU4MjY0NX0.Qdbp9tbiAqomGACI6B8xBu8vtlgOGzbebbl7GkhdoNo';

const db = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// --- APPLICATION STATE ---
let state = {
  currentView: 'home',
  currentUser: null,
  userRole: null,
  catalogs: [],
  chats: [],
  currentChat: null,
  messages: [],
  projects: [],
  users: [],
  selectedCatalog: null,
  siteTitle: 'ER Interiores 3D'
};

// Realtime subscription reference
let realtimeChannel = null;

// --- SUPABASE DATA FUNCTIONS ---

async function loadCatalogs() {
  const { data, error } = await db
    .from('catalogs')
    .select('*')
    .order('created_at', { ascending: true });
  if (!error && data) state.catalogs = data;
}

async function loadUsers() {
  const { data, error } = await db
    .from('users')
    .select('id, email, name, role, created_at');
  if (!error && data) state.users = data;
}

async function loadChats() {
  const { data, error } = await db
    .from('chats_with_names')
    .select('*')
    .order('last_message_time', { ascending: false });
  if (!error && data) {
    state.chats = data.map(c => ({
      ...c,
      clientId: c.client_id,
      clientName: c.client_name,
      catalogId: c.catalog_id,
      catalogName: c.catalog_name,
      lastMessage: c.last_message,
      lastMessageTime: c.last_message_time
    }));
  }
}

async function loadProjects() {
  const { data, error } = await db
    .from('projects_with_names')
    .select('*')
    .order('created_at', { ascending: false });
  if (!error && data) {
    state.projects = data.map(p => ({
      ...p,
      clientId: p.client_id,
      clientName: p.client_name,
      catalogId: p.catalog_id,
      catalogName: p.catalog_name,
      createdAt: p.created_at
    }));
  }
}

async function loadMessagesForChat(chatId) {
  const { data, error } = await db
    .from('messages_with_sender')
    .select('*')
    .eq('chat_id', chatId)
    .order('created_at', { ascending: true });
  if (!error && data) {
    return data.map(m => ({
      ...m,
      chatId: m.chat_id,
      senderId: m.sender_id,
      senderName: m.sender_name,
      senderRole: m.sender_role,
      timestamp: m.created_at
    }));
  }
  return [];
}

async function sendMessage(chatId, content) {
  const { error } = await db
    .from('messages')
    .insert({
      chat_id: chatId,
      sender_id: state.currentUser.id,
      content
    });
  if (error) console.error('Erro ao enviar mensagem:', error);
}

async function createChat(catalogId) {
  const catalog = state.catalogs.find(c => c.id === catalogId);
  const { data, error } = await db
    .from('chats')
    .insert({
      client_id: state.currentUser.id,
      catalog_id: catalogId,
      status: 'pending',
      last_message: 'Nova solicitação de orçamento'
    })
    .select()
    .single();

  if (!error && data) {
    await loadChats();
    return {
      ...data,
      clientId: data.client_id,
      clientName: state.currentUser.name,
      catalogId: data.catalog_id,
      catalogName: catalog ? catalog.name : '',
      lastMessage: data.last_message,
      lastMessageTime: data.last_message_time
    };
  }
  return null;
}

async function hashPassword(password) {
  const encoder = new TextEncoder();
  const data = encoder.encode(password);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

async function loginUser(email, password) {
  const hashedPassword = await hashPassword(password);
  const { data, error } = await db
    .from('users')
    .select('*')
    .eq('email', email)
    .eq('password', hashedPassword)
    .single();

  if (!error && data) {
    state.currentUser = data;
    state.userRole = data.role;
    localStorage.setItem('er_user_id', data.id);
    return true;
  }
  return false;
}

async function registerUser(name, email, password) {
  // Check if email exists
  const { data: existing } = await db
    .from('users')
    .select('id')
    .eq('email', email)
    .single();

  if (existing) {
    return { success: false, message: 'Este email já está cadastrado' };
  }

  const hashedPassword = await hashPassword(password);
  const { data, error } = await db
    .from('users')
    .insert({ name, email, password: hashedPassword, role: 'client' })
    .select()
    .single();

  if (!error && data) {
    return { success: true, message: 'Conta criada com sucesso!' };
  }

  return { success: false, message: 'Erro ao criar conta. Tente novamente.' };
}

async function restoreSession() {
  const userId = localStorage.getItem('er_user_id');
  if (!userId) return;

  const { data, error } = await db
    .from('users')
    .select('*')
    .eq('id', userId)
    .single();

  if (!error && data) {
    state.currentUser = data;
    state.userRole = data.role;
  } else {
    localStorage.removeItem('er_user_id');
  }
}

// --- REALTIME SUBSCRIPTIONS ---

function subscribeToMessages() {
  if (realtimeChannel) {
    db.removeChannel(realtimeChannel);
  }

  realtimeChannel = db
    .channel('messages-realtime')
    .on('postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'messages' },
      async (payload) => {
        const newMsg = payload.new;

        // Update chats list
        await loadChats();

        // If we're viewing this chat, add the message live
        if (state.currentChat && newMsg.chat_id === state.currentChat.id) {
          // Don't duplicate if we sent it
          if (newMsg.sender_id === state.currentUser.id) return;

          // Fetch sender info
          const { data: sender } = await db
            .from('users')
            .select('name, role')
            .eq('id', newMsg.sender_id)
            .single();

          const msg = {
            ...newMsg,
            chatId: newMsg.chat_id,
            senderId: newMsg.sender_id,
            senderName: sender ? sender.name : 'Desconhecido',
            senderRole: sender ? sender.role : 'client',
            timestamp: newMsg.created_at
          };

          // Add message bubble to lateral chat or full chat
          appendMessageToChat(msg);
        }

        // Update floating button badge
        renderFloatingChatButton();
        if (typeof lucide !== 'undefined') lucide.createIcons();
      }
    )
    .subscribe();
}

function appendMessageToChat(msg) {
  // Try lateral chat first
  let container = document.getElementById('lateral-messages-container');
  if (!container) {
    container = document.getElementById('messages-container');
  }
  if (!container) return;

  const isMe = msg.senderId === state.currentUser.id;
  let bubbleClass = '';
  let nameColor = '';

  if (msg.senderRole === 'client') {
    bubbleClass = 'chat-bubble-client';
    nameColor = 'text-forest';
  } else if (msg.senderRole === 'employee') {
    bubbleClass = 'chat-bubble-vendor';
    nameColor = 'text-emerald2';
  } else if (msg.senderRole === 'admin') {
    bubbleClass = 'chat-bubble-admin';
    nameColor = 'text-copper';
  }

  const alignment = isMe ? 'justify-end' : 'justify-start';

  const div = document.createElement('div');
  div.className = `flex ${alignment}`;
  div.innerHTML = `
    <div class="max-w-[80%]">
      <p class="text-[10px] ${nameColor} font-semibold mb-1">${msg.senderName}${msg.senderRole === 'admin' ? ' — ADMIN' : ''}</p>
      <div class="${bubbleClass} px-3.5 py-2.5">
        <p class="text-sm leading-relaxed">${escapeHtml(msg.content)}</p>
      </div>
      <p class="text-[9px] text-charcoal/20 mt-0.5">${formatDate(msg.timestamp)}</p>
    </div>
  `;

  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

// --- SUPABASE ADMIN FUNCTIONS ---

async function addCatalogToDb(catalogData) {
  const { data, error } = await db
    .from('catalogs')
    .insert(catalogData)
    .select()
    .single();
  if (!error) {
    await loadCatalogs();
    render();
  }
}

async function updateCatalogInDb(id, catalogData) {
  const { error } = await db
    .from('catalogs')
    .update(catalogData)
    .eq('id', id);
  if (!error) {
    await loadCatalogs();
    render();
  }
}

async function deleteCatalogFromDb(id) {
  const { error } = await db
    .from('catalogs')
    .delete()
    .eq('id', id);
  if (!error) {
    await loadCatalogs();
    render();
  }
}

async function updateChatStatus(chatId, status) {
  await db
    .from('chats')
    .update({ status })
    .eq('id', chatId);
  await loadChats();
}

// --- UTILITIES ---

function formatDate(date) {
  const d = new Date(date);
  return d.toLocaleDateString('pt-BR') + ' ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

function formatCurrency(value) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value);
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// --- RENDER ENGINE ---

function render() {
  const app = document.getElementById('app');
  switch(state.currentView) {
    case 'home': app.innerHTML = renderHome(); break;
    case 'login': app.innerHTML = renderHome(); setTimeout(() => openModal('login'), 50); break;
    case 'register': app.innerHTML = renderHome(); setTimeout(() => openModal('register'), 50); break;
    case 'catalog-detail': app.innerHTML = renderHome(); setTimeout(() => { if (state.selectedCatalog) openModal('catalog'); }, 50); break;
    case 'client-dashboard': app.innerHTML = renderHome(); break;
    case 'employee-dashboard': app.innerHTML = renderEmployeeDashboard(); break;
    case 'admin-dashboard': app.innerHTML = renderAdminDashboard(); break;
    case 'chat':
      if (state.userRole === 'client') {
        app.innerHTML = renderHome();
        setTimeout(() => openLateralChat(state.currentChat), 50);
      } else {
        app.innerHTML = renderChatView();
      }
      break;
    default: app.innerHTML = renderHome();
  }
  renderFloatingChatButton();
  if (typeof lucide !== 'undefined') lucide.createIcons();
  attachEventListeners();
}

// --- MODAL SYSTEM ---

function openModal(type) {
  closeModal(true);
  let content = '';
  let sizeClass = 'modal-sm';

  if (type === 'login') content = renderLoginModal();
  else if (type === 'register') content = renderRegisterModal();
  else if (type === 'catalog') { content = renderCatalogModal(); sizeClass = 'modal-lg'; }
  else if (type === 'client-projects') { content = renderClientProjectsModal(); sizeClass = 'modal-lg'; }
  else if (type === 'client-messages') { content = renderClientMessagesModal(); sizeClass = 'modal-lg'; }
  else if (type === 'client-account') { content = renderClientAccountModal(); }
  else return;

  const overlay = document.createElement('div');
  overlay.id = 'modal-overlay';
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-content ${sizeClass}" onclick="event.stopPropagation()">
      <button class="modal-close" onclick="closeModal()">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
      ${content}
    </div>
  `;
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });
  document.body.appendChild(overlay);
  document.body.style.overflow = 'hidden';
  if (typeof lucide !== 'undefined') lucide.createIcons();
  attachModalListeners(type);
}

function closeModal(instant) {
  const overlay = document.getElementById('modal-overlay');
  if (!overlay) return;
  if (instant) { overlay.remove(); document.body.style.overflow = ''; return; }
  overlay.classList.add('closing');
  setTimeout(() => { overlay.remove(); document.body.style.overflow = ''; }, 250);
  if (['login', 'register', 'catalog-detail'].includes(state.currentView)) {
    state.currentView = 'home';
  }
}

function attachModalListeners(type) {
  if (type === 'login') {
    const form = document.getElementById('login-form');
    if (form) {
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = form.querySelector('button[type="submit"]');
        btn.disabled = true;
        btn.textContent = 'Entrando...';

        const email = document.getElementById('login-email').value;
        const password = document.getElementById('login-password').value;

        const success = await loginUser(email, password);
        if (success) {
          closeModal(true);
          await Promise.all([loadChats(), loadProjects(), loadUsers()]);
          subscribeToMessages();
          goToDashboard();
        } else {
          const errorDiv = document.getElementById('login-error');
          errorDiv.textContent = 'Email ou senha incorretos';
          errorDiv.classList.remove('hidden');
          btn.disabled = false;
          btn.textContent = 'Entrar';
        }
      });
    }
  } else if (type === 'register') {
    const form = document.getElementById('register-form');
    if (form) {
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = form.querySelector('button[type="submit"]');
        btn.disabled = true;
        btn.textContent = 'Criando...';

        const name = document.getElementById('register-name').value;
        const email = document.getElementById('register-email').value;
        const password = document.getElementById('register-password').value;
        const confirm = document.getElementById('register-confirm').value;

        if (password !== confirm) {
          const errorDiv = document.getElementById('register-error');
          errorDiv.textContent = 'As senhas não coincidem';
          errorDiv.classList.remove('hidden');
          btn.disabled = false;
          btn.textContent = 'Criar conta';
          return;
        }

        const result = await registerUser(name, email, password);
        if (result.success) {
          const successDiv = document.getElementById('register-success');
          successDiv.textContent = result.message;
          successDiv.classList.remove('hidden');
          document.getElementById('register-error').classList.add('hidden');
          setTimeout(async () => {
            await loginUser(email, password);
            closeModal(true);
            await Promise.all([loadChats(), loadProjects(), loadUsers()]);
            subscribeToMessages();
            goToDashboard();
          }, 1500);
        } else {
          const errorDiv = document.getElementById('register-error');
          errorDiv.textContent = result.message;
          errorDiv.classList.remove('hidden');
          btn.disabled = false;
          btn.textContent = 'Criar conta';
        }
      });
    }
  }
}

// --- MODAL RENDERERS ---

function renderLoginModal() {
  return `
    <div class="p-8 md:p-10">
      <div class="text-center mb-8">
        <div class="w-14 h-14 mx-auto mb-4 rounded-2xl bg-forest/[0.06] flex items-center justify-center border border-forest/[0.08]">
          <i data-lucide="lock" class="w-6 h-6 text-forest"></i>
        </div>
        <h2 class="text-2xl font-bold text-forest">Bem-vindo de volta</h2>
        <p class="text-charcoal/40 mt-2 text-sm">Entre na sua conta para continuar</p>
      </div>
      
      <div id="login-error" class="hidden mb-4 p-3 rounded-xl bg-red-50 text-red-600 text-sm border border-red-200 text-center font-medium"></div>
      
      <form id="login-form" class="space-y-5">
        <div>
          <label class="block text-xs font-semibold text-charcoal/50 mb-1.5 uppercase tracking-wide">Email</label>
          <input type="email" id="login-email" required class="input-modern" placeholder="seu@email.com">
        </div>
        <div>
          <label class="block text-xs font-semibold text-charcoal/50 mb-1.5 uppercase tracking-wide">Senha</label>
          <input type="password" id="login-password" required class="input-modern" placeholder="••••••••">
        </div>
        <button type="submit" class="w-full py-3.5 rounded-xl btn-primary text-sm">Entrar</button>
      </form>
      
      <div class="mt-6 text-center">
        <p class="text-charcoal/40 text-sm">
          Não tem conta? 
          <a href="#" onclick="closeModal(true); openModal('register'); return false;" class="text-emerald2 font-bold hover:underline">Cadastre-se</a>
        </p>
      </div>
      
      <div class="divider-modern"></div>
      
      <div class="bg-linen rounded-xl p-4 border border-sand/50">
        <p class="text-[10px] text-charcoal/30 font-semibold text-center mb-2.5 uppercase tracking-widest">Contas de demonstração</p>
        <div class="space-y-1 text-xs text-charcoal/40">
          <p><strong class="text-forest">Admin:</strong> admin@erinteriores3d.com / admin123</p>
          <p><strong class="text-forest">Vendedor:</strong> vendedor@erinteriores3d.com / vendedor123</p>
          <p><strong class="text-forest">Cliente:</strong> cliente@email.com / cliente123</p>
        </div>
      </div>
    </div>
  `;
}

function renderRegisterModal() {
  return `
    <div class="p-8 md:p-10">
      <div class="text-center mb-8">
        <div class="w-14 h-14 mx-auto mb-4 rounded-2xl bg-forest/[0.06] flex items-center justify-center border border-forest/[0.08]">
          <i data-lucide="user-plus" class="w-6 h-6 text-forest"></i>
        </div>
        <h2 class="text-2xl font-bold text-forest">Criar sua conta</h2>
        <p class="text-charcoal/40 mt-2 text-sm">Comece a explorar nossos catálogos</p>
      </div>
      
      <div id="register-error" class="hidden mb-4 p-3 rounded-xl bg-red-50 text-red-600 text-sm border border-red-200 text-center font-medium"></div>
      <div id="register-success" class="hidden mb-4 p-3 rounded-xl bg-emerald-50 text-emerald-700 text-sm border border-emerald-200 text-center font-medium"></div>
      
      <form id="register-form" class="space-y-4">
        <div>
          <label class="block text-xs font-semibold text-charcoal/50 mb-1.5 uppercase tracking-wide">Nome completo</label>
          <input type="text" id="register-name" required class="input-modern" placeholder="Seu nome">
        </div>
        <div>
          <label class="block text-xs font-semibold text-charcoal/50 mb-1.5 uppercase tracking-wide">Email</label>
          <input type="email" id="register-email" required class="input-modern" placeholder="seu@email.com">
        </div>
        <div>
          <label class="block text-xs font-semibold text-charcoal/50 mb-1.5 uppercase tracking-wide">Senha</label>
          <input type="password" id="register-password" required minlength="6" class="input-modern" placeholder="Mínimo 6 caracteres">
        </div>
        <div>
          <label class="block text-xs font-semibold text-charcoal/50 mb-1.5 uppercase tracking-wide">Confirmar senha</label>
          <input type="password" id="register-confirm" required class="input-modern" placeholder="Repita a senha">
        </div>
        <button type="submit" class="w-full py-3.5 rounded-xl btn-primary text-sm">Criar conta</button>
      </form>
      
      <div class="mt-6 text-center">
        <p class="text-charcoal/40 text-sm">
          Já tem conta? 
          <a href="#" onclick="closeModal(true); openModal('login'); return false;" class="text-emerald2 font-bold hover:underline">Entrar</a>
        </p>
      </div>
    </div>
  `;
}

function renderCatalogModal() {
  const catalog = state.selectedCatalog;
  if (!catalog) return '';

  const tags = catalog.tags || [];

  return `
    <div>
      <div class="h-44 catalog-cover flex items-center justify-center rounded-t-[1.25rem]">
        <div class="text-center relative z-10">
          <i data-lucide="layout-grid" class="w-12 h-12 text-white/40 mx-auto mb-2"></i>
          <p class="text-white/80 font-semibold text-lg">${escapeHtml(catalog.name)}</p>
          <p class="text-white/40 text-sm mt-1">${escapeHtml(catalog.specialty || '')}</p>
        </div>
      </div>
      <div class="p-8 md:p-10">
        <div class="flex flex-col md:flex-row md:items-start md:justify-between gap-5 mb-7">
          <div>
            <div class="flex items-center gap-4 mb-3">
              <h2 class="text-2xl font-bold text-forest">${escapeHtml(catalog.name)}</h2>
              <div class="flex items-center gap-1 px-3 py-1 rounded-full bg-emerald2/[0.08] text-emerald2 border border-emerald2/[0.12]">
                <i data-lucide="star" class="w-4 h-4 fill-current"></i>
                <span class="font-bold text-sm">${catalog.rating}</span>
              </div>
            </div>
            <p class="text-charcoal/45 text-sm leading-relaxed">${escapeHtml(catalog.description || '')}</p>
            ${tags.length > 0 ? `
              <div class="flex gap-2 mt-3">
                ${tags.map(t => `<span class="text-[11px] font-semibold text-emerald2/70 bg-emerald2/[0.06] border border-emerald2/[0.1] px-3 py-1 rounded-lg">${escapeHtml(t)}</span>`).join('')}
              </div>
            ` : ''}
          </div>
          <button onclick="requestQuote(${catalog.id})" 
            class="btn-primary px-7 py-3.5 rounded-xl whitespace-nowrap inline-flex items-center gap-2 text-sm">
            <i data-lucide="message-circle" class="w-5 h-5"></i>
            Solicitar Orçamento
          </button>
        </div>
        
        <div class="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-7">
          ${[
            { icon: 'award', label: 'Especialidade', value: catalog.specialty || '-', color: 'emerald2' },
            { icon: 'clock', label: 'Experiência', value: catalog.experience || '-', color: 'emerald2' },
            { icon: 'map-pin', label: 'Localização', value: catalog.city || '-', color: 'forest' },
            { icon: 'briefcase', label: 'Projetos', value: (catalog.projects || 0) + ' realizados', color: 'copper' }
          ].map(item => `
            <div class="bg-linen rounded-xl p-4 border border-sand/40">
              <div class="flex items-center gap-2 mb-1.5">
                <i data-lucide="${item.icon}" class="w-4 h-4 text-${item.color}"></i>
                <span class="text-charcoal/35 text-[10px] font-semibold uppercase tracking-wide">${item.label}</span>
              </div>
              <p class="font-bold text-forest text-sm">${escapeHtml(item.value)}</p>
            </div>
          `).join('')}
        </div>

        <div class="bg-linen rounded-xl p-5 border border-sand/40">
          <h3 class="font-bold text-forest mb-3 text-sm">Galeria de Projetos</h3>
          <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
            ${[1,2,3,4].map(i => `
              <div class="aspect-square rounded-xl bg-gradient-to-br from-forest/10 to-emerald2/10 flex items-center justify-center border border-forest/[0.06]">
                <i data-lucide="${['armchair','sofa','door-open','archive'][i-1]}" class="w-10 h-10 text-forest/20"></i>
              </div>
            `).join('')}
          </div>
        </div>
      </div>
    </div>
  `;
}

// --- CLIENT MODALS ---

function renderClientProjectsModal() {
  if (!state.currentUser) return '';
  const projects = state.projects.filter(p => p.clientId === state.currentUser.id);

  return `
    <div class="p-8 md:p-10">
      <div class="flex items-center gap-3 mb-6">
        <div class="w-12 h-12 rounded-2xl bg-forest/[0.06] flex items-center justify-center border border-forest/[0.08]">
          <i data-lucide="folder" class="w-5 h-5 text-forest"></i>
        </div>
        <div>
          <h2 class="text-xl font-bold text-forest">Meus Projetos</h2>
          <p class="text-charcoal/40 text-sm">${projects.length} projeto${projects.length !== 1 ? 's' : ''}</p>
        </div>
      </div>

      ${projects.length === 0 ? `
        <div class="text-center py-12">
          <i data-lucide="inbox" class="w-12 h-12 text-charcoal/15 mx-auto mb-3"></i>
          <p class="text-charcoal/40 text-sm">Você ainda não tem projetos</p>
          <p class="text-charcoal/25 text-xs mt-1">Solicite um orçamento em nossos catálogos para começar</p>
        </div>
      ` : `
        <div class="space-y-3">
          ${projects.map(project => `
            <div class="p-4 rounded-xl border border-sand/50 hover:border-emerald2/20 transition bg-white">
              <div class="flex items-start justify-between gap-4">
                <div class="flex-1 min-w-0">
                  <div class="flex items-center gap-2 mb-1">
                    <h4 class="font-semibold text-forest text-sm">${escapeHtml(project.title)}</h4>
                    <span class="px-2.5 py-0.5 rounded-full text-[10px] font-bold ${
                      project.status === 'completed' ? 'bg-emerald2/10 text-emerald2' :
                      project.status === 'in_progress' ? 'bg-amber-50 text-amber-600' :
                      'badge-pending'
                    }">
                      ${project.status === 'completed' ? 'Concluído' : project.status === 'in_progress' ? 'Em andamento' : 'Pendente'}
                    </span>
                  </div>
                  <p class="text-xs text-charcoal/40">Via catálogo: ${escapeHtml(project.catalogName || '')}</p>
                  <div class="flex items-center gap-4 mt-2">
                    <span class="text-xs text-charcoal/30">
                      <i data-lucide="calendar" class="w-3 h-3 inline mr-1"></i>
                      ${new Date(project.createdAt).toLocaleDateString('pt-BR')}
                    </span>
                    ${project.value ? `
                      <span class="text-xs font-semibold text-forest">${formatCurrency(project.value)}</span>
                    ` : ''}
                  </div>
                </div>
                <button onclick="closeModal(true); openLateralChatByProject(${project.id})" class="p-2 rounded-lg hover:bg-linen transition" title="Abrir chat">
                  <i data-lucide="message-circle" class="w-4 h-4 text-emerald2"></i>
                </button>
              </div>
            </div>
          `).join('')}
        </div>
      `}
    </div>
  `;
}

function renderClientMessagesModal() {
  if (!state.currentUser) return '';
  const clientChats = state.chats.filter(c => c.clientId === state.currentUser.id);

  return `
    <div class="p-8 md:p-10">
      <div class="flex items-center gap-3 mb-6">
        <div class="w-12 h-12 rounded-2xl bg-forest/[0.06] flex items-center justify-center border border-forest/[0.08]">
          <i data-lucide="message-circle" class="w-5 h-5 text-forest"></i>
        </div>
        <div>
          <h2 class="text-xl font-bold text-forest">Mensagens</h2>
          <p class="text-charcoal/40 text-sm">${clientChats.length} conversa${clientChats.length !== 1 ? 's' : ''}</p>
        </div>
      </div>

      ${clientChats.length === 0 ? `
        <div class="text-center py-12">
          <i data-lucide="message-square" class="w-12 h-12 text-charcoal/15 mx-auto mb-3"></i>
          <p class="text-charcoal/40 text-sm">Nenhuma conversa ainda</p>
          <p class="text-charcoal/25 text-xs mt-1">Solicite um orçamento para iniciar uma conversa</p>
        </div>
      ` : `
        <div class="space-y-2">
          ${clientChats.map(chat => `
            <button onclick="closeModal(true); openLateralChatById(${chat.id})"
              class="w-full p-4 rounded-xl border border-sand/50 hover:border-emerald2/20 hover:bg-linen/50 transition text-left flex items-center gap-3">
              <div class="w-10 h-10 rounded-full bg-forest flex items-center justify-center flex-shrink-0">
                <i data-lucide="message-circle" class="w-4 h-4 text-white"></i>
              </div>
              <div class="flex-1 min-w-0">
                <div class="flex items-center justify-between gap-2">
                  <h4 class="font-semibold text-forest text-sm truncate">${escapeHtml(chat.catalogName || '')}</h4>
                  <span class="px-2 py-0.5 rounded-full text-[10px] font-semibold ${chat.status === 'active' ? 'badge-active' : 'badge-pending'} flex-shrink-0">
                    ${chat.status === 'active' ? 'Ativo' : 'Pendente'}
                  </span>
                </div>
                <p class="text-xs text-charcoal/40 truncate mt-0.5">${escapeHtml(chat.lastMessage || '')}</p>
              </div>
              ${(chat.unread || 0) > 0 ? `
                <span class="w-5 h-5 rounded-full bg-emerald2 text-white text-[10px] font-bold flex items-center justify-center flex-shrink-0">${chat.unread}</span>
              ` : ''}
            </button>
          `).join('')}
        </div>
      `}
    </div>
  `;
}

function renderClientAccountModal() {
  if (!state.currentUser) return '';

  return `
    <div class="p-8 md:p-10">
      <div class="flex items-center gap-3 mb-6">
        <div class="w-12 h-12 rounded-2xl bg-forest/[0.06] flex items-center justify-center border border-forest/[0.08]">
          <i data-lucide="settings" class="w-5 h-5 text-forest"></i>
        </div>
        <div>
          <h2 class="text-xl font-bold text-forest">Minha Conta</h2>
          <p class="text-charcoal/40 text-sm">Gerencie suas informações</p>
        </div>
      </div>

      <div class="space-y-5">
        <div>
          <label class="block text-xs font-semibold text-charcoal/50 mb-1.5 uppercase tracking-wide">Nome</label>
          <input type="text" value="${escapeHtml(state.currentUser.name)}" class="input-modern" readonly>
        </div>
        <div>
          <label class="block text-xs font-semibold text-charcoal/50 mb-1.5 uppercase tracking-wide">Email</label>
          <input type="email" value="${escapeHtml(state.currentUser.email)}" class="input-modern" readonly>
        </div>
        <div class="bg-linen rounded-xl p-4 border border-sand/40">
          <p class="text-xs text-charcoal/40">Para alterar suas informações, entre em contato com nosso suporte.</p>
        </div>
      </div>
    </div>
  `;
}

// --- CLIENT HELPER FUNCTIONS ---

function openLateralChatByProject(projectId) {
  const project = state.projects.find(p => p.id === projectId);
  if (!project) return;
  const chat = state.chats.find(c => c.catalogId === project.catalogId && c.clientId === project.clientId);
  if (chat) openLateralChat(chat);
}

function openLateralChatById(chatId) {
  const chat = state.chats.find(c => c.id === chatId);
  if (chat) openLateralChat(chat);
}

// --- HEADER ---

function renderHeader(showAuth = true) {
  return `
    <header class="glass sticky top-0 z-50 shadow-soft border-b border-sand/50" style="backdrop-filter:blur(12px); background:rgba(250,250,248,0.92);">
      <div class="max-w-7xl mx-auto px-6 h-[72px] flex items-center justify-between">
        <div class="flex items-center gap-3 cursor-pointer group" onclick="navigate('home')">
          <div class="w-10 h-10 rounded-xl bg-forest flex items-center justify-center shadow-md transition-transform group-hover:scale-105">
            <svg class="w-5 h-5 text-white" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" d="M3 9.5L12 3l9 6.5V20a1 1 0 01-1 1H4a1 1 0 01-1-1V9.5z"/>
              <path stroke-linecap="round" stroke-linejoin="round" d="M9 21V12h6v9"/>
            </svg>
          </div>
          <div>
            <h1 class="text-base font-bold text-forest tracking-tight leading-tight">${escapeHtml(state.siteTitle)}</h1>
            <p class="text-[10px] text-sage font-semibold tracking-widest uppercase">Marcenaria & Interiores</p>
          </div>
        </div>
        <nav class="hidden md:flex items-center gap-1">
          <a href="#" onclick="navigate('home'); return false;" class="nav-link px-4 py-2 text-charcoal/60 hover:text-forest transition text-sm font-medium">Início</a>
          <a href="#services" class="nav-link px-4 py-2 text-charcoal/60 hover:text-forest transition text-sm font-medium">Serviços</a>
          <a href="#catalogs" class="nav-link px-4 py-2 text-charcoal/60 hover:text-forest transition text-sm font-medium">Catálogos</a>
          <a href="#about" class="nav-link px-4 py-2 text-charcoal/60 hover:text-forest transition text-sm font-medium">Sobre</a>
        </nav>
        ${showAuth ? `
          <div class="flex items-center gap-2">
            ${state.currentUser ? `
              ${state.userRole === 'client' ? `
                <div class="relative" id="profile-dropdown-container">
                  <button onclick="toggleProfileDropdown()" class="flex items-center gap-2 px-3 py-1.5 rounded-full bg-linen border border-sand/60 hover:border-emerald2/30 transition cursor-pointer">
                    <div class="w-7 h-7 rounded-full bg-forest flex items-center justify-center">
                      <span class="text-white text-xs font-bold">${state.currentUser.name.charAt(0)}</span>
                    </div>
                    <span class="text-sm text-forest font-medium hidden sm:inline">${escapeHtml(state.currentUser.name)}</span>
                    <i data-lucide="chevron-down" class="w-4 h-4 text-charcoal/30"></i>
                  </button>
                  <div id="profile-dropdown" class="profile-dropdown hidden absolute right-0 top-full mt-2 w-56 bg-white rounded-xl shadow-lg border border-sand/60 overflow-hidden z-[60]">
                    <div class="p-4 border-b border-sand/40 bg-linen/50">
                      <p class="text-sm font-bold text-forest">${escapeHtml(state.currentUser.name)}</p>
                      <p class="text-[11px] text-charcoal/40">${escapeHtml(state.currentUser.email)}</p>
                    </div>
                    <div class="py-2">
                      <button onclick="openClientProjects()" class="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-linen transition text-left">
                        <i data-lucide="folder" class="w-4 h-4 text-emerald2"></i>
                        <span class="text-sm text-charcoal/70 font-medium">Meus Projetos</span>
                        ${state.projects.filter(p => p.clientId === state.currentUser.id).length > 0 ? `
                          <span class="ml-auto text-[10px] font-bold bg-emerald2/10 text-emerald2 px-2 py-0.5 rounded-full">${state.projects.filter(p => p.clientId === state.currentUser.id).length}</span>
                        ` : ''}
                      </button>
                      <button onclick="openClientMessages()" class="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-linen transition text-left">
                        <i data-lucide="message-circle" class="w-4 h-4 text-emerald2"></i>
                        <span class="text-sm text-charcoal/70 font-medium">Mensagens</span>
                        ${state.chats.filter(c => c.clientId === state.currentUser.id).length > 0 ? `
                          <span class="ml-auto text-[10px] font-bold bg-copper/10 text-copper px-2 py-0.5 rounded-full">${state.chats.filter(c => c.clientId === state.currentUser.id).length}</span>
                        ` : ''}
                      </button>
                      <button onclick="openClientAccount()" class="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-linen transition text-left">
                        <i data-lucide="settings" class="w-4 h-4 text-charcoal/30"></i>
                        <span class="text-sm text-charcoal/70 font-medium">Minha Conta</span>
                      </button>
                    </div>
                    <div class="border-t border-sand/40 py-2">
                      <button onclick="logout()" class="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-red-50 transition text-left">
                        <i data-lucide="log-out" class="w-4 h-4 text-red-400"></i>
                        <span class="text-sm text-red-500 font-medium">Sair</span>
                      </button>
                    </div>
                  </div>
                </div>
              ` : `
                <div class="flex items-center gap-2">
                  <div class="flex items-center gap-2 px-3 py-1.5 rounded-full bg-linen border border-sand/60">
                    <div class="w-7 h-7 rounded-full bg-forest flex items-center justify-center">
                      <span class="text-white text-xs font-bold">${state.currentUser.name.charAt(0)}</span>
                    </div>
                    <span class="text-sm text-forest font-medium hidden sm:inline">${escapeHtml(state.currentUser.name)}</span>
                  </div>
                  <button onclick="goToDashboard()" class="btn-primary px-5 py-2.5 rounded-xl text-sm">Painel</button>
                  <button onclick="logout()" class="px-4 py-2.5 rounded-xl border border-sand hover:bg-linen transition text-sm text-charcoal/70 font-medium">Sair</button>
                </div>
              `}
            ` : `
              <button onclick="openModal('login')" class="px-5 py-2.5 rounded-xl border border-sand hover:bg-linen transition text-sm text-charcoal/70 font-medium">Entrar</button>
              <button onclick="openModal('register')" class="btn-primary px-5 py-2.5 rounded-xl text-sm">Cadastrar</button>
            `}
          </div>
        ` : ''}
      </div>
    </header>
  `;
}

// --- HOME PAGE ---

function renderHome() {
  return `
    ${renderHeader()}

    <!-- HERO -->
    <section class="hero-pattern relative overflow-hidden">
      <div class="max-w-7xl mx-auto px-6 pt-20 pb-24 md:pt-28 md:pb-32">
        <div class="grid md:grid-cols-2 gap-12 items-center">
          <div class="animate-slide-up">
            <div class="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-emerald2/[0.08] mb-6">
              <span class="w-1.5 h-1.5 rounded-full bg-emerald2"></span>
              <span class="text-emerald2 text-xs font-semibold tracking-wide uppercase">Projetos sob medida</span>
            </div>
            <h1 class="hero-title text-4xl md:text-[3.2rem] leading-[1.15] font-extrabold text-forest mb-5">
              Marcenaria de<br>excelência com<br><span class="text-emerald2">projetos 3D</span>
            </h1>
            <p class="text-base md:text-lg text-charcoal/50 max-w-lg mb-8 leading-relaxed">
              Do conceito à entrega — conectamos você aos melhores profissionais de marcenaria e design de interiores do Brasil.
            </p>
            <div class="flex flex-col sm:flex-row gap-3">
              <a href="#catalogs" class="btn-primary px-7 py-3.5 rounded-xl text-sm inline-flex items-center justify-center gap-2">
                <i data-lucide="search" class="w-4 h-4"></i>
                Ver Catálogos
              </a>
              <button onclick="openModal('register')" class="btn-outline px-7 py-3.5 rounded-xl text-sm inline-flex items-center justify-center gap-2">
                <i data-lucide="user-plus" class="w-4 h-4"></i>
                Criar Conta Grátis
              </button>
            </div>
            <div class="flex items-center gap-6 mt-10 pt-8 border-t border-sand/60">
              <div>
                <p class="text-2xl font-extrabold text-forest stat-number">500+</p>
                <p class="text-xs text-charcoal/40 font-medium">Projetos entregues</p>
              </div>
              <div class="w-px h-10 bg-sand"></div>
              <div>
                <p class="text-2xl font-extrabold text-forest stat-number">4.8</p>
                <p class="text-xs text-charcoal/40 font-medium">Avaliação média</p>
              </div>
              <div class="w-px h-10 bg-sand"></div>
              <div>
                <p class="text-2xl font-extrabold text-forest stat-number">98%</p>
                <p class="text-xs text-charcoal/40 font-medium">Satisfação</p>
              </div>
            </div>
          </div>
          <div class="hidden md:block animate-slide-up delay-2">
            <div class="relative">
              <div class="aspect-[4/3] rounded-3xl catalog-cover flex items-center justify-center shadow-lg">
                <div class="text-center relative z-10 p-8">
                  <div class="w-20 h-20 mx-auto mb-4 rounded-2xl bg-white/10 flex items-center justify-center backdrop-blur-sm border border-white/10">
                    <i data-lucide="box" class="w-10 h-10 text-white/70"></i>
                  </div>
                  <p class="text-white/90 font-bold text-lg mb-1">Visualização 3D</p>
                  <p class="text-white/50 text-sm">Veja seu projeto antes da produção</p>
                </div>
              </div>
              <div class="absolute -bottom-4 -left-4 bg-white rounded-2xl p-4 shadow-lg border border-sand/60 animate-scale-in delay-4">
                <div class="flex items-center gap-3">
                  <div class="w-10 h-10 rounded-xl bg-emerald2/10 flex items-center justify-center">
                    <i data-lucide="shield-check" class="w-5 h-5 text-emerald2"></i>
                  </div>
                  <div>
                    <p class="text-xs font-bold text-forest">Garantia Total</p>
                    <p class="text-[10px] text-charcoal/40">Profissionais verificados</p>
                  </div>
                </div>
              </div>
              <div class="absolute -top-4 -right-4 bg-white rounded-2xl p-4 shadow-lg border border-sand/60 animate-scale-in delay-5">
                <div class="flex items-center gap-3">
                  <div class="w-10 h-10 rounded-xl bg-forest/10 flex items-center justify-center">
                    <i data-lucide="trending-up" class="w-5 h-5 text-forest"></i>
                  </div>
                  <div>
                    <p class="text-xs font-bold text-forest">50+ Profissionais</p>
                    <p class="text-[10px] text-charcoal/40">Em todo o Brasil</p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>

    <div class="section-separator"></div>

    <!-- SERVICES -->
    <section id="services" class="py-20 md:py-24 px-6">
      <div class="max-w-7xl mx-auto">
        <div class="max-w-2xl mb-14">
          <p class="text-emerald2 text-xs font-bold tracking-widest uppercase mb-3">Como funciona</p>
          <h2 class="text-3xl md:text-4xl font-extrabold text-forest mb-4 leading-tight">Processo simples,<br>resultado excepcional</h2>
          <p class="text-charcoal/45 leading-relaxed">Do primeiro contato à entrega final, cada etapa é pensada para garantir a melhor experiência.</p>
        </div>
        <div class="grid md:grid-cols-3 gap-6">
          ${[
            { step: '01', icon: 'search', title: 'Escolha o profissional', desc: 'Navegue pelos catálogos e encontre o marceneiro ideal para o seu projeto com base em especialidade e avaliações.' },
            { step: '02', icon: 'message-circle', title: 'Converse e alinhe', desc: 'Fale diretamente com o profissional pelo chat, compartilhe medidas, referências e receba o orçamento detalhado.' },
            { step: '03', icon: 'box', title: 'Receba seu projeto 3D', desc: 'Visualize cada detalhe do seu móvel em renderização 3D profissional antes de aprovar a produção.' }
          ].map((item, i) => `
            <div class="bg-white rounded-2xl p-7 border border-sand/60 card-hover shadow-soft hover:border-emerald2/25 animate-slide-up delay-${i+1}">
              <div class="flex items-center justify-between mb-6">
                <div class="w-12 h-12 rounded-xl bg-forest/[0.06] flex items-center justify-center">
                  <i data-lucide="${item.icon}" class="w-6 h-6 text-forest"></i>
                </div>
                <span class="text-3xl font-extrabold text-sand/80">${item.step}</span>
              </div>
              <h3 class="text-base font-bold text-forest mb-2">${item.title}</h3>
              <p class="text-charcoal/45 text-sm leading-relaxed">${item.desc}</p>
            </div>
          `).join('')}
        </div>
      </div>
    </section>

    <div class="section-separator"></div>

    <!-- SERVICE CATEGORIES -->
    <section class="py-20 md:py-24 px-6 bg-forest text-white">
      <div class="max-w-7xl mx-auto">
        <div class="text-center mb-14">
          <p class="text-emerald2 text-xs font-bold tracking-widest uppercase mb-3 opacity-70">Especialidades</p>
          <h2 class="text-3xl md:text-4xl font-extrabold mb-4 text-white">O que você procura?</h2>
          <p class="text-white/40 max-w-xl mx-auto">Encontre profissionais especializados em cada tipo de projeto</p>
        </div>
        <div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
          ${[
            { icon: 'chef-hat', label: 'Cozinhas' },
            { icon: 'bed-double', label: 'Quartos' },
            { icon: 'monitor', label: 'Home Office' },
            { icon: 'shirt', label: 'Closets' },
            { icon: 'sofa', label: 'Salas' },
            { icon: 'bath', label: 'Banheiros' }
          ].map(cat => `
            <a href="#catalogs" class="group p-5 rounded-2xl border border-white/[0.08] hover:border-emerald2/40 hover:bg-white/[0.04] transition-all text-center cursor-pointer">
              <div class="w-12 h-12 mx-auto mb-3 rounded-xl bg-white/[0.06] flex items-center justify-center group-hover:bg-emerald2/20 transition">
                <i data-lucide="${cat.icon}" class="w-6 h-6 text-white/50 group-hover:text-emerald2 transition"></i>
              </div>
              <p class="text-sm font-semibold text-white/70 group-hover:text-white transition">${cat.label}</p>
            </a>
          `).join('')}
        </div>
      </div>
    </section>

    <!-- CATALOGS -->
    <section id="catalogs" class="py-20 md:py-24 px-6">
      <div class="max-w-7xl mx-auto">
        <div class="flex flex-col md:flex-row md:items-end md:justify-between gap-4 mb-12">
          <div>
            <p class="text-emerald2 text-xs font-bold tracking-widest uppercase mb-3">Portfólio</p>
            <h2 class="text-3xl md:text-4xl font-extrabold text-forest mb-2">Profissionais Parceiros</h2>
            <p class="text-charcoal/45">Explore e escolha o profissional ideal para o seu projeto</p>
          </div>
          <div class="flex items-center gap-2 text-sm text-charcoal/40">
            <i data-lucide="sliders-horizontal" class="w-4 h-4"></i>
            <span>${state.catalogs.length} profissionais disponíveis</span>
          </div>
        </div>
        <div class="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
          ${state.catalogs.map((catalog, i) => `
            <div class="bg-white rounded-2xl overflow-hidden card-hover cursor-pointer shadow-soft border border-sand/60 hover:border-emerald2/25 group animate-slide-up delay-${(i % 3) + 1}" onclick="viewCatalog(${catalog.id})">
              <div class="h-40 catalog-cover flex items-center justify-center">
                <div class="text-center relative z-10">
                  <i data-lucide="layout-grid" class="w-10 h-10 text-white/40 mx-auto mb-2 group-hover:scale-110 transition-transform duration-300"></i>
                  <p class="text-white/60 text-sm font-medium">Ver Portfólio</p>
                </div>
              </div>
              <div class="p-6">
                <div class="flex items-center justify-between mb-2">
                  <h3 class="text-base font-bold text-forest">${escapeHtml(catalog.name)}</h3>
                  <div class="flex items-center gap-1 text-emerald2">
                    <i data-lucide="star" class="w-3.5 h-3.5 fill-current"></i>
                    <span class="text-sm font-bold">${catalog.rating}</span>
                  </div>
                </div>
                <p class="text-charcoal/40 text-sm mb-4 leading-relaxed line-clamp-2">${escapeHtml(catalog.description || '')}</p>
                <div class="flex flex-wrap gap-1.5 mb-4">
                  <span class="px-2.5 py-1 rounded-lg bg-forest/[0.05] text-forest text-[11px] font-semibold border border-forest/[0.08]">${escapeHtml(catalog.specialty || '')}</span>
                  <span class="px-2.5 py-1 rounded-lg bg-linen text-charcoal/50 text-[11px] font-medium border border-sand/50">${escapeHtml(catalog.experience || '')}</span>
                </div>
                <div class="flex items-center justify-between text-xs text-charcoal/35 font-medium pt-4 border-t border-sand/40">
                  <span class="flex items-center gap-1.5">
                    <i data-lucide="map-pin" class="w-3.5 h-3.5"></i>
                    ${escapeHtml(catalog.city || '')}
                  </span>
                  <span class="font-semibold text-forest">${catalog.projects || 0} projetos</span>
                </div>
              </div>
            </div>
          `).join('')}
        </div>
      </div>
    </section>

    <div class="section-separator"></div>

    <!-- TESTIMONIALS -->
    <section class="py-20 md:py-24 px-6 bg-linen">
      <div class="max-w-7xl mx-auto">
        <div class="text-center mb-14">
          <p class="text-emerald2 text-xs font-bold tracking-widest uppercase mb-3">Depoimentos</p>
          <h2 class="text-3xl md:text-4xl font-extrabold text-forest mb-4">O que nossos clientes dizem</h2>
        </div>
        <div class="grid md:grid-cols-3 gap-6">
          ${[
            { name: 'Ana Souza', city: 'São Paulo', text: 'A qualidade do projeto 3D me surpreendeu. Consegui visualizar cada detalhe antes de aprovar. O resultado ficou exatamente como imaginei.', project: 'Cozinha Planejada' },
            { name: 'Carlos Lima', city: 'Curitiba', text: 'Profissionais extremamente competentes. O processo foi transparente do início ao fim e o prazo foi cumprido perfeitamente.', project: 'Home Office' },
            { name: 'Beatriz Santos', city: 'Rio de Janeiro', text: 'Encontrei o marceneiro ideal em minutos. A plataforma facilitou toda a comunicação e o resultado superou minhas expectativas.', project: 'Closet sob Medida' }
          ].map((t, i) => `
            <div class="testimonial-card bg-white rounded-2xl p-7 border border-sand/60 shadow-soft hover:border-emerald2/20 transition animate-slide-up delay-${i+1}">
              <div class="flex items-center gap-1 mb-4">
                ${[1,2,3,4,5].map(() => '<i data-lucide="star" class="w-3.5 h-3.5 text-emerald2 fill-current"></i>').join('')}
              </div>
              <p class="text-charcoal/60 text-sm leading-relaxed mb-6">${t.text}</p>
              <div class="flex items-center justify-between pt-5 border-t border-sand/50">
                <div class="flex items-center gap-3">
                  <div class="w-9 h-9 rounded-full bg-forest flex items-center justify-center">
                    <span class="text-white text-xs font-bold">${t.name.charAt(0)}</span>
                  </div>
                  <div>
                    <p class="text-sm font-semibold text-forest">${t.name}</p>
                    <p class="text-[11px] text-charcoal/35">${t.city}</p>
                  </div>
                </div>
                <span class="text-[10px] font-semibold text-emerald2/60 bg-emerald2/[0.06] px-2.5 py-1 rounded-lg">${t.project}</span>
              </div>
            </div>
          `).join('')}
        </div>
      </div>
    </section>

    <!-- ABOUT / WHY US -->
    <section id="about" class="py-20 md:py-24 px-6">
      <div class="max-w-7xl mx-auto">
        <div class="grid md:grid-cols-2 gap-16 items-center">
          <div>
            <p class="text-emerald2 text-xs font-bold tracking-widest uppercase mb-3">Sobre nós</p>
            <h2 class="text-3xl md:text-4xl font-extrabold text-forest mb-6 leading-tight">Por que escolher<br>${escapeHtml(state.siteTitle)}?</h2>
            <p class="text-charcoal/45 mb-8 leading-relaxed">Somos a plataforma que conecta clientes exigentes aos melhores profissionais de marcenaria do Brasil, com transparência total em cada etapa.</p>
            <div class="space-y-5">
              ${[
                { icon: 'check-circle-2', title: 'Profissionais Verificados', desc: 'Rigoroso processo de curadoria e verificação de todos os parceiros' },
                { icon: 'headphones', title: 'Suporte Dedicado', desc: 'Equipe especializada acompanha do orçamento à entrega final' },
                { icon: 'eye', title: 'Transparência Total', desc: 'Orçamentos claros, prazos definidos e sem surpresas' },
                { icon: 'refresh-cw', title: 'Garantia de Satisfação', desc: 'Revisões incluídas e compromisso com a qualidade do resultado' }
              ].map(item => `
                <div class="flex items-start gap-4">
                  <div class="w-10 h-10 rounded-xl bg-emerald2/[0.07] flex items-center justify-center flex-shrink-0 mt-0.5">
                    <i data-lucide="${item.icon}" class="w-5 h-5 text-emerald2"></i>
                  </div>
                  <div>
                    <h4 class="font-bold text-forest mb-1 text-sm">${item.title}</h4>
                    <p class="text-charcoal/40 text-sm leading-relaxed">${item.desc}</p>
                  </div>
                </div>
              `).join('')}
            </div>
          </div>
          <div>
            <div class="grid grid-cols-2 gap-4">
              ${[
                { value: '500+', label: 'Projetos Realizados', color: 'text-forest' },
                { value: '50+', label: 'Profissionais Ativos', color: 'text-emerald2' },
                { value: '4.8', label: 'Avaliação Média', color: 'text-forest' },
                { value: '98%', label: 'Taxa de Satisfação', color: 'text-emerald2' }
              ].map(s => `
                <div class="bg-white rounded-2xl p-6 text-center border border-sand/60 shadow-soft hover:border-emerald2/20 transition">
                  <div class="text-3xl font-extrabold ${s.color} stat-number mb-1">${s.value}</div>
                  <div class="text-[11px] text-charcoal/35 font-semibold uppercase tracking-wider">${s.label}</div>
                </div>
              `).join('')}
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- CTA BANNER -->
    <section class="py-20 md:py-24 px-6 bg-forest">
      <div class="max-w-3xl mx-auto text-center">
        <h2 class="text-3xl md:text-4xl font-extrabold text-white mb-4">Pronto para transformar seu espaço?</h2>
        <p class="text-white/40 mb-8 max-w-lg mx-auto">Crie sua conta gratuitamente e conecte-se com os melhores profissionais de marcenaria e design de interiores.</p>
        <div class="flex flex-col sm:flex-row gap-3 justify-center">
          <button onclick="openModal('register')" class="btn-primary px-8 py-4 rounded-xl text-sm inline-flex items-center justify-center gap-2">
            <i data-lucide="arrow-right" class="w-4 h-4"></i>
            Começar Agora
          </button>
          <a href="#catalogs" class="px-8 py-4 rounded-xl border border-white/15 text-white/70 hover:text-white hover:border-white/30 transition text-sm font-semibold inline-flex items-center justify-center gap-2">
            Explorar Catálogos
          </a>
        </div>
      </div>
    </section>

    <!-- FOOTER -->
    <footer class="bg-charcoal text-white/50 py-14 px-6">
      <div class="max-w-7xl mx-auto">
        <div class="grid md:grid-cols-4 gap-10 mb-10">
          <div class="md:col-span-1">
            <div class="flex items-center gap-2 mb-4">
              <div class="w-9 h-9 rounded-lg bg-emerald2 flex items-center justify-center">
                <svg class="w-4 h-4 text-white" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M3 9.5L12 3l9 6.5V20a1 1 0 01-1 1H4a1 1 0 01-1-1V9.5z"/>
                </svg>
              </div>
              <span class="text-sm font-bold text-white">${escapeHtml(state.siteTitle)}</span>
            </div>
            <p class="text-sm leading-relaxed text-white/30">Conectando clientes aos melhores profissionais de marcenaria e design de interiores do Brasil.</p>
          </div>
          <div>
            <h4 class="text-white/80 font-semibold text-sm mb-4">Plataforma</h4>
            <ul class="space-y-2 text-sm">
              <li><a href="#catalogs" class="hover:text-white transition">Catálogos</a></li>
              <li><a href="#services" class="hover:text-white transition">Como Funciona</a></li>
              <li><a href="#about" class="hover:text-white transition">Sobre Nós</a></li>
            </ul>
          </div>
          <div>
            <h4 class="text-white/80 font-semibold text-sm mb-4">Para Profissionais</h4>
            <ul class="space-y-2 text-sm">
              <li><a href="#" onclick="openModal('register'); return false;" class="hover:text-white transition">Cadastre-se</a></li>
              <li><a href="#" class="hover:text-white transition">Seja Parceiro</a></li>
            </ul>
          </div>
          <div>
            <h4 class="text-white/80 font-semibold text-sm mb-4">Contato</h4>
            <ul class="space-y-2 text-sm">
              <li class="flex items-center gap-2"><i data-lucide="mail" class="w-3.5 h-3.5"></i> contato@erinteriores3d.com</li>
              <li class="flex items-center gap-2"><i data-lucide="phone" class="w-3.5 h-3.5"></i> (11) 99999-0000</li>
            </ul>
          </div>
        </div>
        <div class="border-t border-white/[0.06] pt-6 flex flex-col md:flex-row items-center justify-between gap-4">
          <p class="text-xs text-white/25">&copy; 2024 ${escapeHtml(state.siteTitle)}. Todos os direitos reservados.</p>
          <div class="flex items-center gap-4 text-xs text-white/25">
            <a href="#" class="hover:text-white/50 transition">Termos</a>
            <a href="#" class="hover:text-white/50 transition">Privacidade</a>
          </div>
        </div>
      </div>
    </footer>
  `;
}

// --- EMPLOYEE DASHBOARD ---

function renderEmployeeDashboard() {
  return `
    ${renderDashboardHeader('employee')}
    <div class="flex h-[calc(100%-72px)]">
      ${renderDashboardSidebar('employee')}
      <main class="flex-1 p-6 md:p-8 overflow-auto bg-linen scrollbar-thin">
        <div class="max-w-5xl mx-auto">
          <div class="mb-8">
            <h2 class="text-2xl font-bold text-forest">Painel do Vendedor</h2>
            <p class="text-charcoal/40 text-sm mt-1">Gerencie conversas e projetos dos clientes</p>
          </div>
          
          <div class="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
            ${[
              { icon: 'message-circle', color: 'emerald2', value: state.chats.length, label: 'Total Chats' },
              { icon: 'check-circle', color: 'emerald2', value: state.chats.filter(c => c.status === 'active').length, label: 'Ativos' },
              { icon: 'clock', color: 'copper', value: state.chats.filter(c => c.status === 'pending').length, label: 'Pendentes' },
              { icon: 'folder', color: 'forest', value: state.projects.length, label: 'Projetos' }
            ].map(s => `
              <div class="bg-white rounded-xl p-4 shadow-soft border border-sand/50">
                <div class="flex items-center gap-3">
                  <div class="w-10 h-10 rounded-xl bg-${s.color}/[0.07] flex items-center justify-center">
                    <i data-lucide="${s.icon}" class="w-5 h-5 text-${s.color}"></i>
                  </div>
                  <div>
                    <p class="text-2xl font-bold text-forest stat-number">${s.value}</p>
                    <p class="text-xs text-charcoal/35">${s.label}</p>
                  </div>
                </div>
              </div>
            `).join('')}
          </div>

          <div class="bg-white rounded-2xl p-6 mb-6 shadow-soft border border-sand/50">
            <h3 class="font-bold text-forest mb-4 text-sm uppercase tracking-wide">Conversas com Clientes</h3>
            <div class="space-y-2">
              ${state.chats.map(chat => `
                <div onclick="openChat(${chat.id})" class="flex items-center justify-between p-4 rounded-xl hover:bg-linen transition cursor-pointer border border-sand/50">
                  <div class="flex items-center gap-4">
                    <div class="w-10 h-10 rounded-full bg-forest flex items-center justify-center">
                      <i data-lucide="user" class="w-4 h-4 text-white"></i>
                    </div>
                    <div>
                      <p class="font-semibold text-forest text-sm">${escapeHtml(chat.clientName || '')}</p>
                      <p class="text-xs text-charcoal/35 mt-0.5">
                        <span class="text-emerald2 font-medium">Via: ${escapeHtml(chat.catalogName || '')}</span> · ${escapeHtml(chat.lastMessage || '')}
                      </p>
                    </div>
                  </div>
                  <div class="text-right flex items-center gap-3">
                    <span class="inline-block px-3 py-1 rounded-full text-[10px] font-semibold ${chat.status === 'active' ? 'badge-active' : 'badge-pending'}">
                      ${chat.status === 'active' ? 'Ativo' : 'Pendente'}
                    </span>
                    ${(chat.unread || 0) > 0 ? `
                      <span class="inline-flex items-center justify-center w-5 h-5 rounded-full bg-emerald2 text-white text-[10px] font-bold">${chat.unread}</span>
                    ` : ''}
                  </div>
                </div>
              `).join('')}
            </div>
          </div>

          <div class="bg-white rounded-2xl p-6 shadow-soft border border-sand/50">
            <h3 class="font-bold text-forest mb-4 text-sm uppercase tracking-wide">Projetos Recentes</h3>
            <div class="overflow-x-auto">
              <table class="w-full text-sm">
                <thead>
                  <tr class="text-left text-charcoal/30 text-xs uppercase tracking-wide">
                    <th class="pb-4 font-semibold">Cliente</th>
                    <th class="pb-4 font-semibold">Projeto</th>
                    <th class="pb-4 font-semibold">Marceneiro</th>
                    <th class="pb-4 font-semibold">Valor</th>
                    <th class="pb-4 font-semibold">Status</th>
                  </tr>
                </thead>
                <tbody>
                  ${state.projects.map(project => `
                    <tr class="border-t border-sand/50">
                      <td class="py-4 text-forest">${escapeHtml(project.clientName || '')}</td>
                      <td class="py-4 text-forest font-medium">${escapeHtml(project.title)}</td>
                      <td class="py-4 text-charcoal/40">${escapeHtml(project.catalogName || '')}</td>
                      <td class="py-4 text-forest font-bold">${formatCurrency(project.value || 0)}</td>
                      <td class="py-4">
                        <span class="px-3 py-1 rounded-full text-[10px] font-semibold ${project.status === 'completed' ? 'badge-active' : 'badge-pending'}">
                          ${project.status === 'completed' ? 'Concluído' : 'Em andamento'}
                        </span>
                      </td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </main>
    </div>
  `;
}

// --- ADMIN DASHBOARD ---

function renderAdminDashboard() {
  return `
    ${renderDashboardHeader('admin')}
    <div class="flex h-[calc(100%-72px)]">
      ${renderDashboardSidebar('admin')}
      <main class="flex-1 p-6 md:p-8 overflow-auto bg-linen scrollbar-thin">
        <div class="max-w-6xl mx-auto">
          <div class="mb-8">
            <h2 class="text-2xl font-bold text-forest">Painel Administrativo</h2>
            <p class="text-charcoal/40 text-sm mt-1">Visão geral de toda a plataforma</p>
          </div>
          
          <div class="grid grid-cols-2 md:grid-cols-5 gap-4 mb-8">
            ${[
              { value: state.catalogs.length, label: 'Catálogos', color: 'emerald2' },
              { value: state.users.filter(u => u.role === 'client').length, label: 'Clientes', color: 'emerald2' },
              { value: state.users.filter(u => u.role === 'employee').length, label: 'Vendedores', color: 'forest' },
              { value: state.chats.length, label: 'Chats Ativos', color: 'copper' },
              { value: state.projects.length, label: 'Projetos', color: 'forest' }
            ].map(s => `
              <div class="bg-white rounded-xl p-4 shadow-soft border border-sand/50 text-center">
                <p class="text-3xl font-extrabold text-${s.color} stat-number">${s.value}</p>
                <p class="text-[10px] text-charcoal/30 font-semibold uppercase tracking-wide mt-1">${s.label}</p>
              </div>
            `).join('')}
          </div>

          <div class="bg-white rounded-2xl p-6 mb-6 shadow-soft border border-sand/50">
            <div class="flex items-center justify-between mb-4">
              <h3 class="font-bold text-forest text-sm uppercase tracking-wide">Monitor ao Vivo</h3>
              <span class="flex items-center gap-2 text-xs font-semibold text-emerald2">
                <span class="w-2 h-2 rounded-full bg-emerald2 animate-pulse"></span>
                Tempo real
              </span>
            </div>
            <div class="space-y-2">
              ${state.chats.map(chat => `
                <div onclick="openChat(${chat.id})" class="flex items-center justify-between p-4 rounded-xl hover:bg-linen transition cursor-pointer border border-sand/50 ${chat.status === 'active' ? 'border-l-2 border-l-emerald2' : 'border-l-2 border-l-copper'}">
                  <div class="flex items-center gap-4">
                    <div class="w-10 h-10 rounded-full bg-forest/[0.06] flex items-center justify-center">
                      <i data-lucide="eye" class="w-4 h-4 text-forest"></i>
                    </div>
                    <div>
                      <p class="font-semibold text-forest text-sm">${escapeHtml(chat.clientName || '')} — Vendedor</p>
                      <p class="text-xs text-charcoal/35">
                        Catálogo: <span class="text-emerald2 font-medium">${escapeHtml(chat.catalogName || '')}</span>
                      </p>
                      <p class="text-[10px] text-charcoal/20 mt-0.5">${escapeHtml(chat.lastMessage || '')}</p>
                    </div>
                  </div>
                  <div class="flex items-center gap-3">
                    <button onclick="event.stopPropagation(); interveneChat(${chat.id})" class="px-4 py-2 rounded-lg bg-copper/[0.08] text-copper hover:bg-copper/[0.15] transition text-xs font-semibold inline-flex items-center gap-1">
                      <i data-lucide="alert-triangle" class="w-3.5 h-3.5"></i>
                      Intervir
                    </button>
                    <span class="text-[10px] text-charcoal/25">${formatDate(chat.lastMessageTime || new Date())}</span>
                  </div>
                </div>
              `).join('')}
            </div>
          </div>

          <div class="bg-white rounded-2xl p-6 mb-6 shadow-soft border border-sand/50">
            <div class="flex items-center justify-between mb-4">
              <h3 class="font-bold text-forest text-sm uppercase tracking-wide">Gerenciar Catálogos</h3>
              <button onclick="showAddCatalogModal()" class="px-4 py-2 rounded-lg btn-primary text-xs inline-flex items-center gap-1">
                <i data-lucide="plus" class="w-4 h-4"></i>
                Novo Catálogo
              </button>
            </div>
            <div class="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
              ${state.catalogs.map(catalog => `
                <div class="p-4 rounded-xl border border-sand/50 hover:border-sand transition">
                  <div class="flex items-center gap-3 mb-3">
                    <div class="w-10 h-10 rounded-lg bg-forest flex items-center justify-center">
                      <i data-lucide="layout-grid" class="w-5 h-5 text-white"></i>
                    </div>
                    <div class="flex-1 min-w-0">
                      <p class="font-semibold text-forest text-sm truncate">${escapeHtml(catalog.name)}</p>
                      <p class="text-[10px] text-charcoal/30">${escapeHtml(catalog.city || '')}</p>
                    </div>
                  </div>
                  <div class="flex gap-2">
                    <button onclick="editCatalog(${catalog.id})" class="flex-1 px-3 py-2 rounded-lg bg-forest/[0.05] text-forest hover:bg-forest/[0.1] transition text-xs font-semibold">Editar</button>
                    <button onclick="deleteCatalog(${catalog.id})" class="px-3 py-2 rounded-lg bg-red-50 text-red-500 hover:bg-red-100 transition text-xs">
                      <i data-lucide="trash-2" class="w-4 h-4"></i>
                    </button>
                  </div>
                </div>
              `).join('')}
            </div>
          </div>

          <div class="bg-white rounded-2xl p-6 shadow-soft border border-sand/50">
            <h3 class="font-bold text-forest mb-4 text-sm uppercase tracking-wide">Usuários do Sistema</h3>
            <div class="overflow-x-auto">
              <table class="w-full text-sm">
                <thead>
                  <tr class="text-left text-charcoal/30 text-xs uppercase tracking-wide">
                    <th class="pb-4 font-semibold">Nome</th>
                    <th class="pb-4 font-semibold">Email</th>
                    <th class="pb-4 font-semibold">Tipo</th>
                    <th class="pb-4 font-semibold">Ações</th>
                  </tr>
                </thead>
                <tbody>
                  ${state.users.map(user => `
                    <tr class="border-t border-sand/50">
                      <td class="py-4 text-forest font-medium">${escapeHtml(user.name)}</td>
                      <td class="py-4 text-charcoal/40">${escapeHtml(user.email)}</td>
                      <td class="py-4">
                        <span class="px-3 py-1 rounded-full text-[10px] font-semibold ${
                          user.role === 'admin' ? 'badge-admin' :
                          user.role === 'employee' ? 'badge-active' :
                          'badge-pending'
                        }">
                          ${user.role === 'admin' ? 'Admin' : user.role === 'employee' ? 'Vendedor' : 'Cliente'}
                        </span>
                      </td>
                      <td class="py-4">
                        <button class="px-3 py-1 rounded-lg bg-forest/[0.05] text-forest hover:bg-forest/[0.1] transition text-xs font-semibold">Editar</button>
                      </td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </main>
    </div>
  `;
}

// --- DASHBOARD SHARED COMPONENTS ---

function renderDashboardHeader(role) {
  const roleLabels = {
    employee: { label: 'Área do Vendedor' },
    admin: { label: 'Administração' }
  };
  
  return `
    <header class="bg-white h-[72px] px-6 flex items-center justify-between shadow-soft border-b border-sand/50">
      <div class="flex items-center gap-3">
        <div class="w-9 h-9 rounded-xl bg-forest flex items-center justify-center cursor-pointer hover:scale-105 transition" onclick="navigate('home')">
          <svg class="w-4 h-4 text-white" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" d="M3 9.5L12 3l9 6.5V20a1 1 0 01-1 1H4a1 1 0 01-1-1V9.5z"/>
          </svg>
        </div>
        <div>
          <h1 class="font-bold text-forest text-sm">${escapeHtml(state.siteTitle)}</h1>
          <p class="text-[10px] text-charcoal/30 uppercase tracking-widest font-semibold">${roleLabels[role]?.label || ''}</p>
        </div>
      </div>
      <div class="flex items-center gap-2">
        <div class="flex items-center gap-2 px-3 py-1.5 rounded-full bg-linen border border-sand/40">
          <div class="w-7 h-7 rounded-full bg-forest flex items-center justify-center">
            <span class="text-white text-xs font-bold">${state.currentUser ? state.currentUser.name.charAt(0) : ''}</span>
          </div>
          <span class="text-xs text-forest font-medium hidden sm:inline">${state.currentUser ? escapeHtml(state.currentUser.name) : ''}</span>
        </div>
        <button onclick="logout()" class="px-4 py-2 rounded-xl border border-sand/40 hover:bg-linen transition text-xs font-medium text-charcoal/50">Sair</button>
      </div>
    </header>
  `;
}

function renderDashboardSidebar(role) {
  const menuItems = {
    employee: [
      { icon: 'home', label: 'Início', action: 'employee-dashboard' },
      { icon: 'message-circle', label: 'Chats', action: 'employee-dashboard' },
      { icon: 'folder', label: 'Projetos', action: 'employee-dashboard' },
      { icon: 'grid-3x3', label: 'Catálogos', action: 'home' }
    ],
    admin: [
      { icon: 'home', label: 'Dashboard', action: 'admin-dashboard' },
      { icon: 'eye', label: 'Monitor', action: 'admin-dashboard' },
      { icon: 'grid-3x3', label: 'Catálogos', action: 'admin-dashboard' },
      { icon: 'users', label: 'Usuários', action: 'admin-dashboard' },
      { icon: 'settings', label: 'Config', action: 'admin-dashboard' }
    ]
  };

  return `
    <aside class="w-56 border-r border-sand/50 p-4 hidden md:block bg-white">
      <nav class="space-y-1 mt-2">
        ${(menuItems[role] || []).map(item => `
          <button onclick="navigate('${item.action}')" class="w-full flex items-center gap-3 px-4 py-3 rounded-xl sidebar-item text-left group">
            <i data-lucide="${item.icon}" class="w-[18px] h-[18px] text-charcoal/25 group-hover:text-forest transition"></i>
            <span class="text-sm text-charcoal/50 group-hover:text-forest font-medium transition">${item.label}</span>
          </button>
        `).join('')}
      </nav>
    </aside>
  `;
}

// --- FULL CHAT VIEW (Employee / Admin) ---

async function renderChatViewAsync() {
  const chat = state.currentChat;
  if (!chat) { goToDashboard(); return ''; }

  const messages = await loadMessagesForChat(chat.id);
  const isAdmin = state.userRole === 'admin';

  const app = document.getElementById('app');
  app.innerHTML = `
    <div class="h-full flex flex-col bg-linen">
      <header class="bg-white px-6 py-4 flex items-center justify-between shadow-soft border-b border-sand/50">
        <div class="flex items-center gap-4">
          <button onclick="goToDashboard()" class="p-2 rounded-lg hover:bg-linen transition">
            <i data-lucide="arrow-left" class="w-5 h-5 text-forest"></i>
          </button>
          <div class="w-10 h-10 rounded-full bg-forest flex items-center justify-center">
            <i data-lucide="message-circle" class="w-4 h-4 text-white"></i>
          </div>
          <div>
            <h2 class="font-semibold text-forest text-sm">${escapeHtml(chat.clientName || chat.catalogName || '')}</h2>
            <p class="text-[10px] text-charcoal/30">Via catálogo: ${escapeHtml(chat.catalogName || '')}</p>
          </div>
        </div>
        <div class="flex items-center gap-2">
          <span class="px-3 py-1 rounded-full text-[10px] font-semibold ${chat.status === 'active' ? 'badge-active' : 'badge-pending'}">
            ${chat.status === 'active' ? 'Ativo' : 'Pendente'}
          </span>
          ${isAdmin ? `
            <span class="px-3 py-1 rounded-full text-[10px] font-semibold badge-admin inline-flex items-center gap-1">
              <i data-lucide="shield" class="w-3 h-3"></i>
              Admin
            </span>
          ` : ''}
        </div>
      </header>

      <div class="mx-4 mt-4 p-3 rounded-xl border border-emerald2/15 bg-emerald2/[0.03]">
        <div class="flex items-center gap-3">
          <div class="w-8 h-8 rounded-lg bg-emerald2/[0.08] flex items-center justify-center">
            <i data-lucide="info" class="w-4 h-4 text-emerald2"></i>
          </div>
          <div>
            <p class="text-xs font-semibold text-emerald2">Cliente veio pelo catálogo:</p>
            <p class="text-[10px] text-charcoal/35">${escapeHtml(chat.catalogName || '')}</p>
          </div>
        </div>
      </div>

      <div class="flex-1 overflow-auto p-4 space-y-4 scrollbar-thin" id="messages-container">
        ${messages.map(msg => {
          let bubbleClass = '';
          let alignment = '';
          let nameColor = '';
          
          if (msg.senderRole === 'client') {
            bubbleClass = 'chat-bubble-client';
            alignment = state.userRole === 'client' ? 'justify-end' : 'justify-start';
            nameColor = 'text-forest';
          } else if (msg.senderRole === 'employee') {
            bubbleClass = 'chat-bubble-vendor';
            alignment = state.userRole === 'employee' ? 'justify-end' : 'justify-start';
            nameColor = 'text-emerald2';
          } else if (msg.senderRole === 'admin') {
            bubbleClass = 'chat-bubble-admin';
            alignment = state.userRole === 'admin' ? 'justify-end' : 'justify-start';
            nameColor = 'text-copper';
          }

          return `
            <div class="flex ${alignment}">
              <div class="max-w-[75%]">
                <p class="text-[10px] ${nameColor} font-semibold mb-1">${escapeHtml(msg.senderName)}${msg.senderRole === 'admin' ? ' — ADMIN' : ''}</p>
                <div class="${bubbleClass} px-4 py-3">
                  <p class="text-sm leading-relaxed">${escapeHtml(msg.content)}</p>
                </div>
                <p class="text-[10px] text-charcoal/20 mt-1">${formatDate(msg.timestamp)}</p>
              </div>
            </div>
          `;
        }).join('')}
      </div>

      <div class="bg-white p-4 shadow-soft border-t border-sand/50">
        <form id="chat-form" class="flex gap-3">
          <input type="text" id="chat-input" 
            class="flex-1 px-4 py-3 rounded-xl border-2 border-sand/60 bg-white text-forest placeholder-charcoal/25 transition text-sm"
            placeholder="${isAdmin ? 'Mensagem como ADMIN...' : 'Digite sua mensagem...'}"
            autocomplete="off">
          <button type="submit" 
            class="${isAdmin ? 'bg-copper hover:bg-copper/90' : 'btn-primary'} px-5 py-3 rounded-xl transition">
            <i data-lucide="send" class="w-5 h-5 text-white"></i>
          </button>
        </form>
        ${isAdmin ? `
          <p class="text-[10px] text-copper mt-2 text-center font-medium inline-flex items-center justify-center gap-1 w-full">
            <i data-lucide="alert-triangle" class="w-3 h-3"></i>
            Suas mensagens serão destacadas como ADMIN
          </p>
        ` : ''}
      </div>
    </div>
  `;

  if (typeof lucide !== 'undefined') lucide.createIcons();
  attachChatFormListener();

  // Scroll to bottom
  const container = document.getElementById('messages-container');
  if (container) container.scrollTop = container.scrollHeight;
}

function renderChatView() {
  // Async render — show loading then fill
  setTimeout(() => renderChatViewAsync(), 0);
  return `<div class="h-full flex items-center justify-center bg-linen">
    <div class="text-center">
      <div class="w-8 h-8 border-2 border-emerald2 border-t-transparent rounded-full animate-spin mx-auto mb-3"></div>
      <p class="text-sm text-charcoal/40">Carregando conversa...</p>
    </div>
  </div>`;
}

function attachChatFormListener() {
  const chatForm = document.getElementById('chat-form');
  if (chatForm) {
    chatForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = document.getElementById('chat-input');
      const content = input.value.trim();
      
      if (content && state.currentChat) {
        input.value = '';
        input.disabled = true;

        // Optimistic: add to UI immediately
        appendMessageToChat({
          senderId: state.currentUser.id,
          senderName: state.currentUser.name,
          senderRole: state.userRole,
          content,
          timestamp: new Date().toISOString()
        });

        await sendMessage(state.currentChat.id, content);
        input.disabled = false;
        input.focus();
      }
    });
  }
}

// --- CLIENT PROFILE DROPDOWN ---

function toggleProfileDropdown() {
  const dropdown = document.getElementById('profile-dropdown');
  if (dropdown) dropdown.classList.toggle('hidden');
}

document.addEventListener('click', (e) => {
  const container = document.getElementById('profile-dropdown-container');
  const dropdown = document.getElementById('profile-dropdown');
  if (dropdown && container && !container.contains(e.target)) {
    dropdown.classList.add('hidden');
  }
});

function openClientProjects() {
  const dropdown = document.getElementById('profile-dropdown');
  if (dropdown) dropdown.classList.add('hidden');
  openModal('client-projects');
}

function openClientMessages() {
  const dropdown = document.getElementById('profile-dropdown');
  if (dropdown) dropdown.classList.add('hidden');
  openModal('client-messages');
}

function openClientAccount() {
  const dropdown = document.getElementById('profile-dropdown');
  if (dropdown) dropdown.classList.add('hidden');
  openModal('client-account');
}

// --- FLOATING CHAT BUTTON ---

function renderFloatingChatButton() {
  const existing = document.getElementById('floating-chat-btn');
  if (existing) existing.remove();

  if (!state.currentUser || state.userRole !== 'client') return;
  
  const clientChats = state.chats.filter(c => c.clientId === state.currentUser.id);
  if (clientChats.length === 0) return;

  const totalUnread = clientChats.reduce((sum, c) => sum + (c.unread || 0), 0);

  const action = clientChats.length === 1
    ? `openLateralChatById(${clientChats[0].id})`
    : `openClientMessages()`;

  const btn = document.createElement('div');
  btn.id = 'floating-chat-btn';
  btn.innerHTML = `
    <button onclick="${action}" class="floating-chat-button group">
      <i data-lucide="message-circle" class="w-6 h-6 text-white"></i>
      ${totalUnread > 0 ? `<span class="floating-chat-badge">${totalUnread}</span>` : ''}
    </button>
  `;
  document.body.appendChild(btn);
}

// --- LATERAL CHAT PANEL ---

async function openLateralChat(chat) {
  closeLateralChat(true);
  if (!chat) return;
  state.currentChat = chat;

  const messages = await loadMessagesForChat(chat.id);

  const panel = document.createElement('div');
  panel.id = 'lateral-chat-panel';
  panel.className = 'lateral-chat-overlay';
  panel.innerHTML = `
    <div class="lateral-chat-backdrop" onclick="closeLateralChat()"></div>
    <div class="lateral-chat-panel">
      <div class="flex items-center gap-3 p-4 border-b border-sand/50 bg-white">
        <button onclick="closeLateralChat()" class="p-1.5 rounded-lg hover:bg-linen transition">
          <i data-lucide="x" class="w-5 h-5 text-charcoal/40"></i>
        </button>
        <div class="w-9 h-9 rounded-full bg-forest flex items-center justify-center">
          <i data-lucide="message-circle" class="w-4 h-4 text-white"></i>
        </div>
        <div class="flex-1 min-w-0">
          <h3 class="font-semibold text-forest text-sm truncate">${escapeHtml(chat.catalogName || '')}</h3>
          <p class="text-[10px] text-charcoal/30">Conversa sobre orçamento</p>
        </div>
        <span class="px-2.5 py-1 rounded-full text-[10px] font-semibold ${chat.status === 'active' ? 'badge-active' : 'badge-pending'}">
          ${chat.status === 'active' ? 'Ativo' : 'Pendente'}
        </span>
      </div>

      <div class="mx-3 mt-3 p-2.5 rounded-lg border border-emerald2/15 bg-emerald2/[0.03]">
        <div class="flex items-center gap-2">
          <i data-lucide="info" class="w-3.5 h-3.5 text-emerald2"></i>
          <p class="text-[11px] text-emerald2 font-medium">Catálogo: ${escapeHtml(chat.catalogName || '')}</p>
        </div>
      </div>

      <div class="flex-1 overflow-auto p-4 space-y-3 scrollbar-thin" id="lateral-messages-container">
        ${messages.map(msg => {
          const isMe = msg.senderId === state.currentUser.id;
          let bubbleClass = '';
          let nameColor = '';
          
          if (msg.senderRole === 'client') {
            bubbleClass = 'chat-bubble-client';
            nameColor = 'text-forest';
          } else if (msg.senderRole === 'employee') {
            bubbleClass = 'chat-bubble-vendor';
            nameColor = 'text-emerald2';
          } else if (msg.senderRole === 'admin') {
            bubbleClass = 'chat-bubble-admin';
            nameColor = 'text-copper';
          }

          return `
            <div class="flex ${isMe ? 'justify-end' : 'justify-start'}">
              <div class="max-w-[80%]">
                <p class="text-[10px] ${nameColor} font-semibold mb-1">${escapeHtml(msg.senderName)}${msg.senderRole === 'admin' ? ' — ADMIN' : ''}</p>
                <div class="${bubbleClass} px-3.5 py-2.5">
                  <p class="text-sm leading-relaxed">${escapeHtml(msg.content)}</p>
                </div>
                <p class="text-[9px] text-charcoal/20 mt-0.5">${formatDate(msg.timestamp)}</p>
              </div>
            </div>
          `;
        }).join('')}
      </div>

      <div class="p-3 border-t border-sand/50 bg-white">
        <form id="lateral-chat-form" class="flex gap-2">
          <input type="text" id="lateral-chat-input"
            class="flex-1 px-3.5 py-2.5 rounded-xl border-2 border-sand/60 bg-white text-forest placeholder-charcoal/25 transition text-sm"
            placeholder="Digite sua mensagem..." autocomplete="off">
          <button type="submit" class="btn-primary px-4 py-2.5 rounded-xl transition">
            <i data-lucide="send" class="w-4 h-4 text-white"></i>
          </button>
        </form>
      </div>
    </div>
  `;

  document.body.appendChild(panel);
  document.body.style.overflow = 'hidden';
  if (typeof lucide !== 'undefined') lucide.createIcons();

  setTimeout(() => {
    const container = document.getElementById('lateral-messages-container');
    if (container) container.scrollTop = container.scrollHeight;
  }, 50);

  const form = document.getElementById('lateral-chat-form');
  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = document.getElementById('lateral-chat-input');
      const content = input.value.trim();
      if (content && state.currentChat) {
        input.value = '';
        input.disabled = true;

        // Optimistic
        appendMessageToChat({
          senderId: state.currentUser.id,
          senderName: state.currentUser.name,
          senderRole: state.userRole,
          content,
          timestamp: new Date().toISOString()
        });

        await sendMessage(state.currentChat.id, content);
        input.disabled = false;
        input.focus();
      }
    });
  }
}

function closeLateralChat(instant) {
  const panel = document.getElementById('lateral-chat-panel');
  if (!panel) return;
  if (instant) { panel.remove(); document.body.style.overflow = ''; return; }
  panel.classList.add('closing');
  setTimeout(() => { panel.remove(); document.body.style.overflow = ''; }, 300);
  if (state.currentView === 'chat' && state.userRole === 'client') {
    state.currentView = 'home';
  }
}

// --- NAVIGATION ---

function navigate(view) {
  state.currentView = view;
  render();
  window.scrollTo(0, 0);
}

function goToDashboard() {
  if (!state.currentUser) {
    openModal('login');
    return;
  }
  
  switch(state.userRole) {
    case 'admin': navigate('admin-dashboard'); break;
    case 'employee': navigate('employee-dashboard'); break;
    case 'client': navigate('home'); break;
    default: navigate('home');
  }
}

function viewCatalog(catalogId) {
  state.selectedCatalog = state.catalogs.find(c => c.id === catalogId);
  openModal('catalog');
}

async function requestQuote(catalogId) {
  if (!state.currentUser) {
    closeModal(true);
    openModal('login');
    return;
  }
  
  closeModal(true);
  const newChat = await createChat(catalogId);

  if (newChat) {
    state.currentChat = newChat;
    if (state.userRole === 'client') {
      openLateralChat(newChat);
    } else {
      navigate('chat');
    }
  }
}

function openChat(chatId) {
  state.currentChat = state.chats.find(c => c.id === chatId);
  if (state.userRole === 'client') {
    openLateralChat(state.currentChat);
  } else {
    navigate('chat');
  }
}

function interveneChat(chatId) {
  state.currentChat = state.chats.find(c => c.id === chatId);
  navigate('chat');
}

// --- AUTH ---

async function login(email, password) {
  const success = await loginUser(email, password);
  if (success) {
    closeModal(true);
    await Promise.all([loadChats(), loadProjects(), loadUsers()]);
    subscribeToMessages();
    goToDashboard();
    return true;
  }
  return false;
}

function logout() {
  state.currentUser = null;
  state.userRole = null;
  state.currentChat = null;
  localStorage.removeItem('er_user_id');
  if (realtimeChannel) {
    db.removeChannel(realtimeChannel);
    realtimeChannel = null;
  }
  navigate('home');
}

async function register(name, email, password) {
  return await registerUser(name, email, password);
}

// --- ADMIN ACTIONS ---

async function showAddCatalogModal() {
  const name = 'Novo Catálogo ' + (state.catalogs.length + 1);
  await addCatalogToDb({
    name,
    description: 'Descrição do novo catálogo',
    specialty: 'Móveis Planejados',
    experience: '5 anos',
    city: 'São Paulo',
    rating: 5.0,
    projects: 0,
    tags: []
  });
}

function editCatalog(id) {
  console.log('Edit catalog:', id);
}

async function deleteCatalog(id) {
  await deleteCatalogFromDb(id);
}

// --- EVENT LISTENERS ---

function attachEventListeners() {
  // Chat form in full view (employee/admin)
  attachChatFormListener();
}

// --- ELEMENT SDK ---

const defaultConfig = {
  site_title: 'ER Interiores 3D'
};

if (window.elementSdk) {
  window.elementSdk.init({
    defaultConfig,
    onConfigChange: async (config) => {
      state.siteTitle = config.site_title || defaultConfig.site_title;
      render();
    },
    mapToCapabilities: (config) => ({
      recolorables: [],
      borderables: [],
      fontEditable: undefined,
      fontSizeable: undefined
    }),
    mapToEditPanelValues: (config) => new Map([
      ['site_title', config.site_title || defaultConfig.site_title]
    ])
  });
}

// --- APP INIT ---

async function initApp() {
  // Show loading
  const app = document.getElementById('app');
  app.innerHTML = `
    <div class="h-full flex items-center justify-center">
      <div class="text-center">
        <div class="w-10 h-10 border-2 border-emerald2 border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
        <p class="text-sm text-charcoal/40 font-medium">Carregando ER Interiores 3D...</p>
      </div>
    </div>
  `;

  // Restore session + load data in parallel
  await restoreSession();
  await Promise.all([loadCatalogs(), loadChats(), loadProjects(), loadUsers()]);

  // Subscribe to realtime if logged in
  if (state.currentUser) {
    subscribeToMessages();
  }

  render();
}

initApp();
