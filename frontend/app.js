// FYNOR Clone - JavaScript Application

// Dynamically determine API URL based on environment
const API_URL = (() => {
  // In production, use the same domain as the frontend
  // In development with localhost:3000 backend, use it directly
  if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
    return 'http://localhost:3000';
  }
  // In production, use the current origin (same domain)
  return window.location.origin;
})();

let authToken = null;
let currentUser = null;
let ws = null;
let currentSort = 'hot'; // Default sort
let allPairs = []; // Store market pairs globally

// Symbol helpers
function apiSymbol(symbol) {
    if (!symbol) return symbol;
    return symbol.replace(/\//g, '_'); // API-friendly (no slashes in path)
}

function canonicalSymbol(symbol) {
    if (!symbol) return symbol;
    return symbol.replace(/[_-]/g, '/'); // Display/storage format
}

// ==================== INITIALIZATION ====================

document.addEventListener('DOMContentLoaded', () => {
    // Check for token in URL (from Google OAuth redirect)
    const urlParams = new URLSearchParams(window.location.search);
    const tokenFromUrl = urlParams.get('token');

    if (tokenFromUrl) {
        authToken = tokenFromUrl;
        localStorage.setItem('authToken', tokenFromUrl);
        // Clean URL
        window.history.replaceState({}, document.title, window.location.pathname);
        loadCurrentUser();
    } else {
        // Check for stored token
        authToken = localStorage.getItem('authToken');
        if (authToken) {
            loadCurrentUser();
        }
    }

    // Load market data
    loadMarketData();

    // Connect WebSocket
    connectWebSocket();

    // Setup tab switching
    setupTabs();

    // Init Trade Page
    if (window.location.href.includes('trade.html')) {
        initTradePage();
    }

    // Init FAQ
    initFAQ();
});

// ==================== AUTHENTICATION ====================

function showLoginModal() {
    closeAllModals();
    document.getElementById('loginModal').style.display = 'block';
}

function showRegisterModal() {
    closeAllModals();
    document.getElementById('registerModal').style.display = 'block';
}

function closeModal(modalId) {
    document.getElementById(modalId).style.display = 'none';
}

function closeAllModals() {
    const modals = document.querySelectorAll('.modal');
    modals.forEach(modal => modal.style.display = 'none');
}

// Close modal when clicking outside
window.onclick = function (event) {
    if (event.target.classList.contains('modal')) {
        event.target.style.display = 'none';
    }
}

async function handleLogin(event) {
    event.preventDefault();

    // Support both modal (`loginEmail`, `loginPassword`) and page (`loginEmailPage`, `loginPasswordPage`)
    const emailEl = document.getElementById('loginEmail') || document.getElementById('loginEmailPage');
    const passwordEl = document.getElementById('loginPassword') || document.getElementById('loginPasswordPage');

    const email = emailEl ? emailEl.value.trim() : '';
    const password = passwordEl ? passwordEl.value : '';

    try {
        const response = await fetch(`${API_URL}/auth/login`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ email, password }),
        });

        const data = await response.json();

        if (response.ok) {
            authToken = data.token;
            localStorage.setItem('authToken', authToken);
            currentUser = data.user;
            updateUIForLoggedInUser();

            // If on standalone login page, redirect to home
            if (window.location.pathname.endsWith('login.html')) {
                showAlert('Login successful! Redirecting...', 'success');
                setTimeout(() => { window.location.href = 'index.html'; }, 800);
            } else {
                closeModal('loginModal');
                showAlert('Login successful!', 'success');
            }
        } else {
            showAlert(data.error || 'Login failed', 'error');
        }
    } catch (error) {
        console.error('Login error:', error);
        showAlert('An error occurred. Please try again.', 'error');
    }
}

async function handleRegister(event) {
    event.preventDefault();

    // Support both modal (`registerName`, `registerEmail`, `registerPassword`)
    // and standalone page (`registerNamePage`, `registerEmailPage`, `registerPasswordPage`)
    const nameEl = document.getElementById('registerName') || document.getElementById('registerNamePage');
    const emailEl = document.getElementById('registerEmail') || document.getElementById('registerEmailPage');
    const passwordEl = document.getElementById('registerPassword') || document.getElementById('registerPasswordPage');

    let full_name = nameEl ? nameEl.value.trim() : '';
    const email = emailEl ? emailEl.value.trim() : '';
    const password = passwordEl ? passwordEl.value : '';

    // Support referral/invite code fields
    const referral = (document.getElementById('referralCode') && document.getElementById('referralCode').value) || (document.getElementById('registerInvitePage') && document.getElementById('registerInvitePage').value) || undefined;

    if (!full_name && email) {
        full_name = email.split('@')[0];
    }

    try {
        const body = { full_name, email, password };
        if (referral) body.referral = referral;

        const response = await fetch(`${API_URL}/auth/register`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
        });

        const data = await response.json();

        if (response.ok) {
            authToken = data.token;
            localStorage.setItem('authToken', authToken);
            currentUser = data.user;
            updateUIForLoggedInUser();

            // If on standalone register page, redirect to home
            if (window.location.pathname.endsWith('register.html')) {
                showAlert('Account created successfully! Redirecting...', 'success');
                setTimeout(() => { window.location.href = 'index.html'; }, 1000);
            } else {
                closeModal('registerModal');
                showAlert('Account created successfully!', 'success');
            }
        } else {
            showAlert(data.error || 'Registration failed', 'error');
        }
    } catch (error) {
        console.error('Register error:', error);
        showAlert('An error occurred. Please try again.', 'error');
    }
}

function loginWithGoogle() {
    window.location.href = `${API_URL}/auth/google`;
}

async function loadCurrentUser() {
    if (!authToken) return;

    try {
        const response = await fetch(`${API_URL}/auth/me`, {
            headers: {
                'Authorization': `Bearer ${authToken}`,
            },
        });

        if (response.ok) {
            currentUser = await response.json();
            updateUIForLoggedInUser();
        } else {
            logout();
        }
    } catch (error) {
        console.error('Load user error:', error);
        logout();
    }
}

function updateUIForLoggedInUser() {
    const authButtons = document.getElementById('authButtons');
    const userMenu = document.getElementById('userMenu');
    const userName = document.getElementById('userName');
    const userAvatar = document.getElementById('userAvatar');

    if (authButtons) authButtons.style.display = 'none';
    if (userMenu) userMenu.style.display = 'block';
    if (userName) userName.textContent = currentUser.full_name || currentUser.email;

    if (userAvatar) {
        if (currentUser.avatar_url) {
            userAvatar.src = currentUser.avatar_url;
        } else {
            userAvatar.src = `https://ui-avatars.com/api/?name=${encodeURIComponent(currentUser.full_name || currentUser.email)}&background=3b82f6&color=fff`;
        }
    }
}

function toggleUserDropdown() {
    const dropdown = document.getElementById('userDropdown');
    if (dropdown) {
        dropdown.style.display = dropdown.style.display === 'none' ? 'block' : 'none';
    }
}

function logout() {
    authToken = null;
    currentUser = null;
    localStorage.removeItem('authToken');

    const authButtons = document.getElementById('authButtons');
    const userMenu = document.getElementById('userMenu');
    if (authButtons) authButtons.style.display = 'flex';
    if (userMenu) userMenu.style.display = 'none';

    showAlert('Logged out successfully', 'info');
}

// ==================== MARKET DATA ====================

async function loadMarketData() {
    try {
        const response = await fetch(`${API_URL}/market/pairs`);
        if (!response.ok) throw new Error('Failed to fetch market data');

        const pairs = await response.json();
        const grid = document.getElementById('marketGrid');

        if (pairs.length === 0 && grid) {
            grid.innerHTML = '<div style="text-align: center; padding: 2rem;">No market pairs available</div>';
            return;
        }

        // Store pairs globally
        window.allPairs = pairs;

        displayMarketData(pairs);
        populateHeroTicker(pairs);
    } catch (error) {
        console.error('Load market data error:', error);
        const grid = document.getElementById('marketGrid');
        if (grid) {
            grid.innerHTML = `<div style="text-align: center; padding: 2rem; color: var(--danger-color);">
                Error loading market data. <br>
                <small>${error.message}</small>
            </div>`;
        }
    }
}

function populateHeroTicker(pairs) {
    const tickerList = document.getElementById('heroTickerList');
    if (!tickerList) return;

    // Get top 5 pairs
    const topPairs = pairs.slice(0, 5);

    tickerList.innerHTML = topPairs.map(pair => {
        const change = parseFloat(pair.change_24h);
        const changeClass = change >= 0 ? 'positive' : 'negative';
        const changeSign = change >= 0 ? '+' : '';
        const [base, quote] = pair.symbol.split('/');

        return `
            <div class="ticker-item">
                <div class="ticker-coin">
                    <div class="ticker-coin-icon">${base[0]}</div>
                    <span class="ticker-coin-name">${base}/${quote}</span>
                </div>
                <span class="ticker-price">${parseFloat(pair.last_price).toLocaleString()}</span>
                <span class="ticker-change ${changeClass}">${changeSign}${change.toFixed(2)}%</span>
            </div>
        `;
    }).join('');
}

function displayMarketData(pairs) {
    const grid = document.getElementById('marketGrid');
    if (!grid) return; // Guard clause

    // Store pairs globally for filtering
    if (!window.allPairs) window.allPairs = pairs;

    // Apply current sort/filter
    filterAndDisplayMarketData();
}

function filterAndDisplayMarketData() {
    const grid = document.getElementById('marketGrid');
    if (!grid || !window.allPairs) return;

    let displayPairs = [...window.allPairs];

    // Filter based on page (if we are on market.html or index.html)
    // For now, let's just handle the sorting as requested

    if (typeof currentSort !== 'undefined') {
        switch (currentSort) {
            case 'gainers':
                // Sort by change_24h descending
                displayPairs.sort((a, b) => parseFloat(b.change_24h) - parseFloat(a.change_24h));
                break;
            case 'volume':
                // Sort by volume_24h descending
                displayPairs.sort((a, b) => parseFloat(b.volume_24h) - parseFloat(a.volume_24h));
                break;
            case 'hot':
            default:
                // Default sort (maybe volume or just as is)
                // Let's keep original order or defined hot logic
                break;
        }
    }

    grid.innerHTML = '';

    // Display top 10
    displayPairs.slice(0, 10).forEach(pair => {
        const changeClass = parseFloat(pair.change_24h) >= 0 ? 'positive' : 'negative';
        const changeSign = parseFloat(pair.change_24h) >= 0 ? '+' : '';

        const card = document.createElement('div');
        card.className = 'market-card';
        card.onclick = () => goToTrade(pair.symbol);

        card.innerHTML = `
            <div class="market-card-header">
                <div class="market-pair">${pair.symbol}</div>
                <div class="market-change ${changeClass}">
                    ${changeSign}${parseFloat(pair.change_24h).toFixed(2)}%
                </div>
            </div>
            <div class="market-price">
                $${parseFloat(pair.last_price).toLocaleString('en-US', {
            minimumFractionDigits: 2,
            maximumFractionDigits: 8
        })}
            </div>
            <div class="market-stats">
                <div>24h High: $${parseFloat(pair.high_24h).toFixed(2)}</div>
                <div>24h Low: $${parseFloat(pair.low_24h).toFixed(2)}</div>
                <div>Volume: ${parseFloat(pair.volume_24h).toFixed(2)}</div>
            </div>
        `;

        grid.appendChild(card);
    });
}

function goToTrade(symbol) {
    if (!currentUser) {
        showAlert('Please log in to start trading', 'info');
        showLoginModal();
        return;
    }


    // Redirect to trade page
    window.location.href = `trade.html?symbol=${symbol}`;
}

async function initTradePage() {
    const urlParams = new URLSearchParams(window.location.search);
    const symbol = urlParams.get('symbol') || 'BTC/USDT';

    // Update Header
    const pairInfo = document.querySelector('.pair-info h2');
    if (pairInfo) pairInfo.textContent = symbol;

    // Fetch Ticker
    try {
        const safeSymbol = encodeURIComponent(apiSymbol(symbol));
        const tickerResponse = await fetch(`${API_URL}/market/ticker/${safeSymbol}`);

        if (tickerResponse.ok) {
            const ticker = await tickerResponse.json();
            updateTradePageUI(ticker);
            loadOpenOrders(); // Load open orders
        }
    } catch (error) {
        console.error('Error fetching ticker:', error);
    }
}

function updateTradePageUI(ticker) {
    if (!ticker || !document.querySelector('.pair-price')) return;

    // Update Price
    document.querySelector('.pair-price').textContent = `$${parseFloat(ticker.last_price).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;

    // Update Change
    const changeElem = document.querySelector('.pair-header div:nth-child(2) div:nth-child(1) span');
    if (changeElem) {
        const change = parseFloat(ticker.change_24h);
        changeElem.textContent = `${change >= 0 ? '+' : ''}${change.toFixed(2)}%`;
        changeElem.style.color = change >= 0 ? 'var(--secondary-color)' : 'var(--danger-color)';
    }

    // Update Form Price
    const priceInput = document.getElementById('orderPrice');
    if (priceInput) priceInput.value = parseFloat(ticker.last_price).toFixed(2);
}

// ==================== WEBSOCKET ====================

function connectWebSocket() {
    ws = new WebSocket('ws://localhost:3000');

    ws.onopen = () => {
        console.log('✅ WebSocket connected');
    };

    ws.onmessage = (event) => {
        try {
            const message = JSON.parse(event.data);

            if (message.type === 'MARKET_UPDATE') {
                displayMarketData(message.data);
            }
        } catch (error) {
            console.error('WebSocket message error:', error);
        }
    };

    ws.onclose = () => {
        console.log('❌ WebSocket disconnected');
        // Reconnect after 5 seconds
        setTimeout(connectWebSocket, 5000);
    };

    ws.onerror = (error) => {
        console.error('WebSocket error:', error);
    };
}

// ==================== WALLET ====================

async function showWallet() {
    if (!authToken) {
        showAlert('Please log in to view your wallet', 'info');
        showLoginModal();
        return;
    }

    try {
        const response = await fetch(`${API_URL}/wallet/balances`, {
            headers: {
                'Authorization': `Bearer ${authToken}`,
            },
        });

        if (response.ok) {
            const balances = await response.json();
            displayWallet(balances);
            document.getElementById('walletModal').style.display = 'block';
        } else {
            showAlert('Failed to load wallet', 'error');
        }
    } catch (error) {
        console.error('Load wallet error:', error);
        showAlert('An error occurred', 'error');
    }
}

function displayWallet(balances) {
    const container = document.getElementById('walletBalances');
    container.innerHTML = '';

    balances.forEach(balance => {
        const item = document.createElement('div');
        item.className = 'wallet-balance-item';

        item.innerHTML = `
            <div>
                <div class="balance-currency">${balance.currency}</div>
                <div style="color: var(--text-secondary); font-size: 0.875rem;">Available</div>
            </div>
            <div>
                <div class="balance-amount">
                    ${parseFloat(balance.balance).toFixed(8)}
                </div>
                ${parseFloat(balance.locked_balance) > 0 ? `
                    <div style="color: var(--text-secondary); font-size: 0.875rem;">
                        Locked: ${parseFloat(balance.locked_balance).toFixed(8)}
                    </div>
                ` : ''}
            </div>
        `;

        container.appendChild(item);
    });
}

// ==================== UTILITY FUNCTIONS ====================

function setupTabs() {
    const tabs = document.querySelectorAll('.tab');
    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            tabs.forEach(t => t.classList.remove('active'));
            tab.classList.add('active');

            const tabType = tab.getAttribute('data-tab');
            if (tabType) {
                // If on market page
                currentSort = tabType;
                filterAndDisplayMarketData();
            } else if (tab.textContent.includes('Open')) {
                // If on orders page
                loadOrdersPage('OPEN');
            } else if (tab.textContent.includes('History')) {
                // If on orders page
                loadOrdersPage('FILLED');
            }
        });
    });
}

function scrollToMarket() {
    document.getElementById('market').scrollIntoView({ behavior: 'smooth' });
}

function showAlert(message, type = 'info') {
    // Create alert element
    const alert = document.createElement('div');
    alert.className = `alert alert-${type}`;
    alert.textContent = message;
    alert.style.position = 'fixed';
    alert.style.top = '20px';
    alert.style.right = '20px';
    alert.style.zIndex = '3000';
    alert.style.minWidth = '300px';
    alert.style.animation = 'slideIn 0.3s ease-out';

    document.body.appendChild(alert);

    // Remove after 3 seconds
    setTimeout(() => {
        alert.style.animation = 'slideOut 0.3s ease-out';
        setTimeout(() => {
            document.body.removeChild(alert);
        }, 300);
    }, 3000);
}

// Add animations
const style = document.createElement('style');
style.textContent = `
    @keyframes slideIn {
        from {
            transform: translateX(400px);
            opacity: 0;
        }
        to {
            transform: translateX(0);
            opacity: 1;
        }
    }
    
    @keyframes slideOut {
        from {
            transform: translateX(0);
            opacity: 1;
        }
        to {
            transform: translateX(400px);
            opacity: 0;
        }
    }
`;
document.head.appendChild(style);

// Make functions available globally
window.showLoginModal = showLoginModal;
window.showRegisterModal = showRegisterModal;
window.closeModal = closeModal;
window.handleLogin = handleLogin;
window.handleRegister = handleRegister;
window.loginWithGoogle = loginWithGoogle;
window.toggleUserDropdown = toggleUserDropdown;
window.logout = logout;
window.scrollToMarket = scrollToMarket;
window.showWallet = showWallet;

// Update navigation logic (not needed for static pages)
// document.addEventListener('DOMContentLoaded', () => { ... });

// ==================== PAGE SPECIFIC FUNCTIONS ====================

async function loadWalletPage() {
    if (!authToken) {
        window.location.href = 'index.html';
        return;
    }

    try {
        const response = await fetch(`${API_URL}/wallet/balances`, {
            headers: {
                'Authorization': `Bearer ${authToken}`,
            },
        });

        if (response.ok) {
            const balances = await response.json();
            const container = document.getElementById('wallet-assets-list');
            if (container) {
                container.innerHTML = balances.map(balance => `
                <div class="asset-card">
                    <div class="asset-info">
                        <div class="asset-icon">${balance.currency.substring(0, 1)}</div>
                        <div>
                            <div style="font-weight: bold; font-size: 1.1rem;">${balance.currency}</div>
                            <div style="color: var(--text-secondary); font-size: 0.9rem;">${balance.currency === 'USDT' ? 'Tether' : balance.currency === 'BTC' ? 'Bitcoin' : 'Ethereum'}</div>
                        </div>
                    </div>
                    <div style="text-align: right;">
                        <div style="font-weight: bold; font-size: 1.1rem;">${parseFloat(balance.balance).toFixed(8)}</div>
                        <div style="color: var(--text-secondary); font-size: 0.9rem;">
                            ${parseFloat(balance.locked_balance) > 0 ? `Locked: ${parseFloat(balance.locked_balance).toFixed(8)}` : 'Available'}
                        </div>
                    </div>
                </div>
                `).join('');
            }
        }
    } catch (error) {
        console.error('Load wallet page error:', error);
    }
}

async function loadOrdersPage(status = 'OPEN') {
    if (!authToken) {
        window.location.href = 'index.html';
        return;
    }

    // Update tabs
    document.querySelectorAll('.tab').forEach(t => {
        if (t.textContent.includes(status === 'OPEN' ? 'Open' : 'History')) t.classList.add('active');
        else t.classList.remove('active');
    });

    try {
        const response = await fetch(`${API_URL}/trading/orders?status=${status}`, {
            headers: {
                'Authorization': `Bearer ${authToken}`,
            },
        });

        if (response.ok) {
            const orders = await response.json();
            const tbody = document.getElementById('orders-table-body');
            if (tbody) {
                if (orders.length === 0) {
                    tbody.innerHTML = `
                        <tr>
                            <td colspan="8" style="text-align: center; color: var(--text-secondary); padding: 2rem;">
                                No ${status.toLowerCase()} orders found
                            </td>
                        </tr>
                    `;
                    return;
                }

                tbody.innerHTML = orders.map(order => `
                    <tr>
                        <td>${new Date(order.created_at).toLocaleString()}</td>
                        <td>${order.symbol}</td>
                        <td class="${order.side === 'BUY' ? 'order-type-buy' : 'order-type-sell'}" style="font-weight: bold;">${order.side}</td>
                        <td>${parseFloat(order.price).toFixed(2)}</td>
                        <td>${parseFloat(order.quantity).toFixed(8)}</td>
                        <td>${(parseFloat(order.price) * parseFloat(order.quantity)).toFixed(2)}</td>
                        <td><span class="status-badge status-${order.status.toLowerCase()}">${order.status}</span></td>
                        <td>
                            ${order.status === 'OPEN' ? `
                                <button class="btn btn-outline" style="padding: 0.25rem 0.5rem; font-size: 0.8rem;" onclick="cancelOrder(${order.id})">Cancel</button>
                            ` : '-'}
                        </td>
                    </tr>
                `).join('');
            }
        }
    } catch (error) {
        console.error('Load orders page error:', error);
    }
}

async function cancelOrder(orderId) {
    if (!confirm('Are you sure you want to cancel this order?')) return;

    try {
        const response = await fetch(`${API_URL}/trading/order/${orderId}`, {
            method: 'DELETE',
            headers: {
                'Authorization': `Bearer ${authToken}`,
            },
        });

        if (response.ok) {
            showAlert('Order cancelled successfully', 'success');
            loadOrdersPage('OPEN');
        } else {
            const data = await response.json();
            showAlert(data.error || 'Failed to cancel order', 'error');
        }
    } catch (error) {
        console.error('Cancel order error:', error);
        showAlert('An error occurred', 'error');
    }
}

function showDepositForm() {
    showAlert('Deposit feature coming soon!', 'info');
}

function showWithdrawForm() {
    showAlert('Withdrawal feature coming soon!', 'info');
}

async function placeOrder(event) {
    event.preventDefault();

    if (!authToken) {
        showAlert('Please log in to trade', 'info');
        showLoginModal();
        return;
    }

    const price = document.getElementById('orderPrice').value;
    const amount = document.getElementById('orderAmount').value;

    // Determine side from active tab
    const activeTab = document.querySelector('.order-tab.active');
    const side = activeTab ? activeTab.innerText.toUpperCase() : 'BUY';

    // Determine symbol from URL or Header
    const urlParams = new URLSearchParams(window.location.search);
    const symbol = urlParams.get('symbol') ? decodeURIComponent(urlParams.get('symbol')) : 'BTC/USDT';

    try {
        const response = await fetch(`${API_URL}/trading/order`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${authToken}`,
            },
            body: JSON.stringify({
                symbol: apiSymbol(symbol),
                side,
                type: 'LIMIT', // Default to LIMIT for now
                price,
                quantity: amount
            }),
        });

        const data = await response.json();

        if (response.ok) {
            showAlert(`${side} Order placed successfully!`, 'success');
            // Refresh orders if on trade page
            loadOpenOrders();
            // Refresh wallet/balance if possible (need to implement updateBalance)
        } else {
            showAlert(data.error || 'Order failed', 'error');
        }
    } catch (error) {
        console.error('Place order error:', error);
        showAlert('An error occurred', 'error');
    }
}

async function loadOpenOrders() {
    // Re-use logic from orders page or create specific mini-list for trade page
    // The trade.html has a div id="openOrders"
    try {
        const response = await fetch(`${API_URL}/trading/orders?status=OPEN`, {
            headers: { 'Authorization': `Bearer ${authToken}` }
        });
        if (response.ok) {
            const orders = await response.json();
            // Filter for current symbol
            const urlParams = new URLSearchParams(window.location.search);
            const currentSymbol = urlParams.get('symbol') || 'BTC/USDT';
            const myOrders = orders.filter(o => o.symbol === currentSymbol).slice(0, 5);

            const container = document.getElementById('openOrders');
            if (container) {
                if (myOrders.length === 0) {
                    container.innerHTML = 'No open orders';
                    return;
                }
                container.innerHTML = myOrders.map(o => `
                    <div style="display: flex; justify-content: space-between; padding: 0.5rem; border-bottom: 1px solid var(--border-color); font-size: 0.8rem;">
                        <span class="${o.side === 'BUY' ? 'price-buy' : 'price-sell'}">${o.side}</span>
                        <span>${parseFloat(o.price).toFixed(2)}</span>
                        <span>${parseFloat(o.quantity).toFixed(8)}</span>
                        <span style="cursor: pointer;" onclick="cancelOrder(${o.id})">&times;</span>
                    </div>
                 `).join('');
            }
        }
    } catch (e) { console.error(e); }
}

function showDepositModal() {
    closeAllModals();
    document.getElementById('depositModal').style.display = 'block';
}

function showWithdrawModal() {
    closeAllModals();
    document.getElementById('withdrawModal').style.display = 'block';
}

function copyToClipboard(text) {
    navigator.clipboard.writeText(text).then(() => {
        showAlert('Address copied to clipboard!', 'success');
    }).catch(err => {
        console.error('Failed to copy:', err);
        showAlert('Failed to copy', 'error');
    });
}

function handleWithdraw(event) {
    event.preventDefault();
    const currency = document.getElementById('withdrawCurrency').value;
    const address = document.getElementById('withdrawAddress').value;
    const amount = document.getElementById('withdrawAmount').value;

    // Simulate withdrawal interaction
    setTimeout(() => {
        closeModal('withdrawModal');
        showAlert(`Withdrawal request for ${amount} ${currency} submitted!`, 'success');
    }, 1000);
}

function initFAQ() {
    const questions = document.querySelectorAll('.faq-question');

    questions.forEach(question => {
        question.addEventListener('click', () => {
            const answer = question.nextElementSibling;
            const isOpen = question.classList.contains('active');

            // Close all other answers
            document.querySelectorAll('.faq-question').forEach(q => {
                q.classList.remove('active');
                q.nextElementSibling.style.maxHeight = null;
            });

            // Toggle current
            if (!isOpen) {
                question.classList.add('active');
                answer.style.maxHeight = answer.scrollHeight + "px";
            }
        });
    });
}

// ==================== THEME TOGGLE ====================

function toggleTheme() {
    const html = document.documentElement;
    const isDark = html.classList.toggle('dark');
    
    // Store preference in localStorage
    localStorage.setItem('theme', isDark ? 'dark' : 'light');
}

// Initialize theme on page load
function initializeTheme() {
    const savedTheme = localStorage.getItem('theme') || 'light';
    const html = document.documentElement;
    
    if (savedTheme === 'dark') {
        html.classList.add('dark');
    } else {
        html.classList.remove('dark');
    }
}

// Run on page load
document.addEventListener('DOMContentLoaded', initializeTheme);

// Make new functions global
window.loadWalletPage = loadWalletPage;
window.loadOrdersPage = loadOrdersPage;
window.cancelOrder = cancelOrder;
window.showDepositModal = showDepositModal;
window.showWithdrawModal = showWithdrawModal;
window.handleWithdraw = handleWithdraw;
window.copyToClipboard = copyToClipboard;
window.loadOrders = loadOrdersPage;
window.placeOrder = placeOrder;
window.loadOpenOrders = loadOpenOrders;
window.toggleTheme = toggleTheme;
window.handleLogin = handleLogin;
window.handleRegister = handleRegister;
