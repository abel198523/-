let currentUserId = null;
let currentStake = 10;
let ws = null;
let isRegistered = false;

function initializeWalletActions() {
    const depositBtn = document.getElementById('btn-deposit-telebirr');
    const withdrawBtn = document.getElementById('btn-withdraw');

    if (depositBtn) {
        depositBtn.addEventListener('click', () => {
            if (window.Telegram && window.Telegram.WebApp) {
                window.Telegram.WebApp.showAlert('ዲፖዚት ለማድረግ እባክዎ በቴሌግራም ቦቱ ውስጥ "💳 Deposit" የሚለውን ቁልፍ ይጠቀሙ።');
                window.Telegram.WebApp.close();
            } else {
                alert('እባክዎ በቴሌግራም ቦቱ ውስጥ "💳 Deposit" የሚለውን ቁልፍ ይጠቀሙ።');
            }
        });
    }

    if (withdrawBtn) {
        withdrawBtn.addEventListener('click', () => {
            if (window.Telegram && window.Telegram.WebApp) {
                window.Telegram.WebApp.showAlert('ገንዘብ ለማውጣት እባክዎ በቴሌግራም ቦቱ ውስጥ "💸 Withdraw" የሚለውን ቁልፍ ይጠቀሙ።');
                window.Telegram.WebApp.close();
            } else {
                alert('እባክዎ በቴሌግራም ቦቱ ውስጥ "💸 Withdraw" የሚለውን ቁልፍ ይጠቀሙ።');
            }
        });
    }
}

document.addEventListener('DOMContentLoaded', function() {
    initializeUser();
    checkRegistrationAndProceed();
    initializeBingoButton();
    initializeGlobalMenu();
    initializeWalletActions();
    checkAdminStatus();
});

function initializeGlobalMenu() {
    const trigger = document.getElementById('menu-trigger');
    const closeBtn = document.getElementById('close-menu');
    const menu = document.getElementById('side-menu');
    
    if (trigger && menu) {
        trigger.addEventListener('click', () => {
            menu.classList.add('active');
        });
    }
    
    if (closeBtn && menu) {
        closeBtn.addEventListener('click', () => {
            menu.classList.remove('active');
        });
    }
    
    // Menu items navigation
    const menuItems = document.querySelectorAll('.menu-item');
    menuItems.forEach(item => {
        item.addEventListener('click', function() {
            const target = this.dataset.target;
            if (!target) return;
            
            menu.classList.remove('active');
            
            // Re-use footer navigation logic for screen switching
            const landingScreen = document.getElementById('landing-screen');
            const selectionScreen = document.getElementById('selection-screen');
            const profileScreen = document.getElementById('profile-screen');
            const gameScreen = document.getElementById('game-screen');
            
            if (landingScreen) landingScreen.style.display = 'none';
            if (selectionScreen) selectionScreen.style.display = 'none';
            if (profileScreen) profileScreen.style.display = 'none';
            if (gameScreen) gameScreen.style.display = 'none';
            
            if (target === 'profile') {
                if (profileScreen) profileScreen.style.display = 'flex';
                loadProfile();
            } else if (target === 'wallet') {
                const walletScreen = document.getElementById('wallet-screen');
                if (walletScreen) walletScreen.style.display = 'flex';
                loadWallet();
            } else if (target === 'admin') {
                window.location.href = '/admin.html';
            }
            updateBackButtonVisibility();
        });
    });

    const globalBackBtn = document.getElementById('global-back-btn');
    if (globalBackBtn) {
        globalBackBtn.addEventListener('click', () => {
            const screens = ['selection-screen', 'profile-screen', 'wallet-screen', 'game-screen'];
            screens.forEach(id => {
                const el = document.getElementById(id);
                if (el) el.style.display = 'none';
            });
            
            const landingScreen = document.getElementById('landing-screen');
            if (landingScreen) landingScreen.style.display = 'flex';
            
            const footerButtons = document.querySelectorAll('.footer-btn');
            footerButtons.forEach(b => b.classList.remove('active'));
            const gameBtn = document.querySelector('.footer-btn[data-target="game"]');
            if (gameBtn) gameBtn.classList.add('active');
            
            updateBackButtonVisibility();
        });
    }
}

function updateBackButtonVisibility() {
    const backBtn = document.getElementById('global-back-btn');
    if (!backBtn) return;
    
    const landingScreen = document.getElementById('landing-screen');
    if (landingScreen && landingScreen.style.display !== 'none') {
        backBtn.style.display = 'none';
    } else {
        backBtn.style.display = 'block';
    }
}

async function checkAdminStatus() {
    if (!currentUserId) return;
    try {
        const response = await fetch(`/api/check-admin/${currentUserId}`);
        const data = await response.json();
        if (data.isAdmin) {
            const adminItem = document.getElementById('admin-menu-item');
            if (adminItem) adminItem.style.display = 'flex';
        }
    } catch (err) {
        console.error('Error checking admin status:', err);
    }
}

async function checkRegistrationAndProceed() {
    if (!currentUserId) {
        showRegistrationRequired();
        return;
    }
    
    try {
        const response = await fetch(`/api/check-registration/${currentUserId}`);
        const data = await response.json();
        
        if (data.registered) {
            isRegistered = true;
            hideRegistrationRequired();
            loadWallet();
            initializeWebSocket();
            initializeLandingScreen();
            initializeFooterNavigation();
        } else {
            showRegistrationRequired();
        }
    } catch (error) {
        console.error('Error checking registration:', error);
        showRegistrationRequired();
    }
}

function showRegistrationRequired() {
    const landingScreen = document.getElementById('landing-screen');
    const selectionScreen = document.getElementById('selection-screen');
    const gameScreen = document.getElementById('game-screen');
    const profileScreen = document.getElementById('profile-screen');
    
    if (landingScreen) landingScreen.style.display = 'none';
    if (selectionScreen) selectionScreen.style.display = 'none';
    if (gameScreen) gameScreen.style.display = 'none';
    if (profileScreen) profileScreen.style.display = 'none';
    
    let regScreen = document.getElementById('registration-required-screen');
    if (!regScreen) {
        regScreen = document.createElement('div');
        regScreen.id = 'registration-required-screen';
        regScreen.style.cssText = 'position: fixed; top: 0; left: 0; width: 100%; height: 100%; z-index: 9999;';
        regScreen.innerHTML = `
            <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%); color: white; text-align: center; padding: 20px;">
                <h1 style="font-size: 2em; margin-bottom: 20px;">🎰 ሮያል ቢንጎ</h1>
                <div style="background: rgba(255,255,255,0.1); padding: 30px; border-radius: 15px; max-width: 300px;">
                    <p style="font-size: 1.2em; margin-bottom: 20px;">⚠️ አልተመዘገቡም</p>
                    <p style="margin-bottom: 20px;">ይህን ጨዋታ ለመጫወት መጀመሪያ መመዝገብ አለብዎት።</p>
                    <p style="margin-bottom: 20px;">እባክዎ ወደ Telegram ቦት ተመልሰው <strong>"📱 Register"</strong> ቁልፍን ይጫኑ።</p>
                    <p style="font-size: 0.9em; color: #aaa;">ከተመዘገቡ በኋላ 10 ብር ቦነስ ያገኛሉ! 🎁</p>
                </div>
            </div>
        `;
        document.body.appendChild(regScreen);
    }
    regScreen.style.display = 'block';
}

function hideRegistrationRequired() {
    const regScreen = document.getElementById('registration-required-screen');
    if (regScreen) {
        regScreen.style.display = 'none';
    }
}

function initializeFooterNavigation() {
    const footerButtons = document.querySelectorAll('.footer-btn');
    
    footerButtons.forEach(btn => {
        btn.addEventListener('click', function() {
            const target = this.dataset.target;
            
            footerButtons.forEach(b => b.classList.remove('active'));
            this.classList.add('active');
            
            const landingScreen = document.getElementById('landing-screen');
            const selectionScreen = document.getElementById('selection-screen');
            const profileScreen = document.getElementById('profile-screen');
            const gameScreen = document.getElementById('game-screen');
            
            if (landingScreen) landingScreen.style.display = 'none';
            if (selectionScreen) selectionScreen.style.display = 'none';
            if (profileScreen) profileScreen.style.display = 'none';
            if (gameScreen) gameScreen.style.display = 'none';
            
            if (target === 'game') {
                if (landingScreen) landingScreen.style.display = 'flex';
            } else if (target === 'wallet') {
                const walletScreen = document.getElementById('wallet-screen');
                if (walletScreen) walletScreen.style.display = 'flex';
                loadWallet();
            } else if (target === 'profile') {
                if (profileScreen) profileScreen.style.display = 'flex';
                loadProfile();
            }
            updateBackButtonVisibility();
        });
    });
    
    const profileRefreshBtn = document.getElementById('profile-refresh-btn');
    if (profileRefreshBtn) {
        profileRefreshBtn.addEventListener('click', loadProfile);
    }
}

async function loadProfile() {
    if (!currentUserId) {
        console.log('No user ID for profile');
        return;
    }
    
    try {
        const response = await fetch(`/api/profile/${currentUserId}`);
        const data = await response.json();
        
        if (data.success && data.profile) {
            const profile = data.profile;
            
            const avatarLetter = document.getElementById('profile-avatar-letter');
            if (avatarLetter) {
                avatarLetter.textContent = (profile.username || 'P').charAt(0).toUpperCase();
            }
            
            const usernameEl = document.getElementById('profile-username-header');
            if (usernameEl) usernameEl.textContent = profile.username || '---';
            
            const miniappIdEl = document.getElementById('profile-miniapp-id');
            if (miniappIdEl) miniappIdEl.textContent = profile.id || '---';
            
            const telegramIdEl = document.getElementById('profile-telegram-id');
            if (telegramIdEl) telegramIdEl.textContent = profile.telegramId || '---';
            
            const phoneEl = document.getElementById('profile-phone');
            if (phoneEl) phoneEl.textContent = profile.phoneNumber || '---';
            
            const balanceEl = document.getElementById('profile-balance');
            if (balanceEl) balanceEl.textContent = `${parseFloat(profile.balance).toFixed(2)} ETB`;
            
            const gamesEl = document.getElementById('profile-total-games');
            if (gamesEl) gamesEl.textContent = profile.totalGames || 0;
            
            const winsEl = document.getElementById('profile-wins');
            if (winsEl) winsEl.textContent = profile.wins || 0;
        }
    } catch (error) {
        console.error('Error loading profile:', error);
    }
}

function initializeLandingScreen() {
    const landingScreen = document.getElementById('landing-screen');
    const selectionScreen = document.getElementById('selection-screen');
    const startBtn = document.getElementById('start-selection-btn');
    const stakeButtons = document.querySelectorAll('.stake-btn');
    
    // Automatically select Stake 10 and move to selection
    if (landingScreen && selectionScreen) {
        currentStake = 10;
        window.currentStake = 10;
        // Don't auto-transition here, let the user see the landing screen and click Start
        // unless they are returning from a game.
    }

    stakeButtons.forEach(btn => {
        btn.addEventListener('click', function() {
            const stake = parseInt(this.dataset.stake);
            currentStake = stake;
            window.currentStake = stake;
            
            stakeButtons.forEach(b => b.classList.remove('active-stake'));
            this.classList.add('active-stake');
            
            if (startBtn) {
                startBtn.textContent = `▷ Play ${stake} ETB`;
            }
            
            const currentStakeDisplay = document.getElementById('current-stake');
            if (currentStakeDisplay) {
                currentStakeDisplay.textContent = stake;
            }
        });
    });

    const refreshWalletBtn = document.getElementById('refresh-wallet-btn');
    if (refreshWalletBtn) {
        refreshWalletBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            refreshWalletBtn.classList.add('rotating');
            loadWallet().finally(() => {
                setTimeout(() => refreshWalletBtn.classList.remove('rotating'), 500);
            });
        });
    }
    
    if (startBtn) {
        startBtn.addEventListener('click', function() {
            // Check balance before allowing to proceed to selection screen
            fetch(`/api/wallet-info/${currentUserId}`)
                .then(res => res.json())
                .then(data => {
                    const totalBalance = data.total_balance !== undefined ? data.total_balance : (parseFloat(data.balance) || 0);
                    const stake = data.stake || 10;
                    
                    if (totalBalance < stake) {
                        showNoBalanceModal(totalBalance, stake);
                        return;
                    }
                    
                    if (landingScreen) landingScreen.style.display = 'none';
                    if (selectionScreen) selectionScreen.style.display = 'flex';
                    
                    generateCardSelection();
                    updateBackButtonVisibility();
                })
                .catch(err => {
                    console.error('Error checking balance:', err);
                    // Fallback to local profile check if API fails
                    if (window.userProfile && parseFloat(window.userProfile.totalBalance) < 10) {
                        showNoBalanceModal(window.userProfile.totalBalance, 10);
                        return;
                    }
                    
                    if (landingScreen) landingScreen.style.display = 'none';
                    if (selectionScreen) selectionScreen.style.display = 'flex';
                    generateCardSelection();
                });
        });
    }
}

function showNoBalanceModal(balance, stake) {
    const modal = document.createElement('div');
    modal.className = 'no-balance-modal';
    modal.innerHTML = `
        <div class="no-balance-content">
            <div class="no-balance-icon">⚠️</div>
            <h2>በቂ ገንዘብ የልዎትም</h2>
            <p>ለመሳተፍ ቢያንስ <b>${stake} ETB</b> ያስፈልጋል።</p>
            <p>ያለዎት ባላንስ: <b>${balance.toFixed(2)} ETB</b></p>
            <div class="no-balance-actions">
                <button class="no-balance-btn deposit" onclick="window.location.reload()">ተመለስ</button>
                <button class="no-balance-btn main" id="go-to-bot-btn">ገንዘብ አስገባ (Deposit)</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
    
    document.getElementById('go-to-bot-btn').addEventListener('click', () => {
        if (window.Telegram && window.Telegram.WebApp) {
            window.Telegram.WebApp.close();
        } else {
            modal.remove();
        }
    });
}

let selectedCardId = null;
let previewCardId = null;
let cardConfirmed = false;

function generateCardSelection() {
    const grid = document.getElementById('card-selection-grid');
    if (!grid) return;
    
    // Add timer display if not exists
    let timerContainer = document.getElementById('selection-timer-container');
    if (!timerContainer) {
        timerContainer = document.createElement('div');
        timerContainer.id = 'selection-timer-container';
        timerContainer.style.cssText = 'text-align: center; margin-bottom: 15px; font-weight: bold; font-size: 1.2em; color: #ffcc00;';
        grid.parentNode.insertBefore(timerContainer, grid);
    }
    
    grid.innerHTML = '';
    
    for (let cardId = 1; cardId <= 100; cardId++) {
        const cardElement = document.createElement('div');
        cardElement.className = 'card-number-btn';
        cardElement.dataset.cardId = cardId;
        cardElement.id = `card-btn-${cardId}`;
        cardElement.textContent = cardId;
        
        cardElement.addEventListener('click', function(e) {
            e.preventDefault();
            e.stopPropagation();
            if (this.classList.contains('taken')) return;
            
            console.log('Card clicked:', cardId);
            
            if (!cardConfirmed) {
                showCardPreview(cardId);
            }
        });
        
        cardElement.addEventListener('touchstart', function(e) {
            // Let the click event handle it to avoid double firing
            // but ensure we're capturing touches for mobile
            console.log('Card touchstart:', cardId);
        }, {passive: true});
        
        if (cardConfirmed && cardId === selectedCardId) {
            cardElement.classList.add('selected');
            cardElement.style.setProperty('background-color', '#00c8ff', 'important'); // Blue color for own selected card
            cardElement.style.setProperty('border-color', '#00c8ff', 'important');
            cardElement.style.setProperty('color', 'white', 'important');
        }
        
        grid.appendChild(cardElement);
    }
}

function updateTakenCards(takenCards) {
    takenCards.forEach(cardId => {
        markCardAsTaken(cardId);
    });
}

function markCardAsTaken(cardId) {
    // Don't mark as taken if it's the current player's selected card
    if (cardId === selectedCardId) return;

    const btn = document.getElementById(`card-btn-${cardId}`);
    if (btn) {
        btn.classList.add('taken');
        btn.style.setProperty('background-color', '#ff4d4d', 'important'); // Red color
        btn.style.setProperty('border-color', '#ff4d4d', 'important');
        btn.style.setProperty('color', 'white', 'important');
        btn.style.setProperty('opacity', '0.6', 'important');
        btn.style.setProperty('cursor', 'not-allowed', 'important');
        btn.style.setProperty('pointer-events', 'none', 'important');
    }
}

function showCardPreview(cardId) {
    console.log('Showing preview for card:', cardId);
    previewCardId = cardId;
    const modal = document.getElementById('card-preview-modal');
    const previewGrid = document.getElementById('preview-card-grid');
    const previewTitle = document.getElementById('preview-card-title');
    
    if (!modal || !previewGrid) {
        console.error('Modal or grid not found');
        return;
    }
    
    const cardData = BINGO_CARDS[cardId];
    if (!cardData) {
        console.error('Card data not found for ID:', cardId);
        return;
    }
    
    previewTitle.textContent = `ካርድ #${cardId}`;
    previewGrid.innerHTML = '';
    
    cardData.forEach((row, rowIndex) => {
        row.forEach((num, colIndex) => {
            const cell = document.createElement('div');
            cell.className = 'preview-cell';
            
            if (rowIndex === 2 && colIndex === 2) {
                cell.classList.add('free-space');
                cell.textContent = '★';
            } else {
                cell.textContent = num;
            }
            
            previewGrid.appendChild(cell);
        });
    });
    
    // Force visibility and high z-index
    modal.style.setProperty('display', 'flex', 'important');
    modal.style.setProperty('z-index', '99999', 'important');
    modal.style.setProperty('visibility', 'visible', 'important');
    modal.style.setProperty('opacity', '1', 'important');
    modal.classList.add('active');
    console.log('Modal display set to flex, zIndex 99999');
}

function hideCardPreview() {
    const modal = document.getElementById('card-preview-modal');
    if (modal) {
        modal.style.display = 'none';
        modal.classList.remove('active');
    }
    previewCardId = null;
}

function confirmPreviewCard() {
    if (previewCardId) {
        cardConfirmed = true;
        selectedCardId = previewCardId;
        
        document.querySelectorAll('.card-number-btn').forEach(btn => {
            btn.classList.remove('selected');
            // Reset inline styles for non-taken cards
            if (!btn.classList.contains('taken')) {
                btn.style.backgroundColor = '';
                btn.style.borderColor = '';
                btn.style.color = '';
            }
            
            if (parseInt(btn.dataset.cardId) === selectedCardId) {
                btn.classList.add('selected');
                btn.style.setProperty('background-color', '#00c8ff', 'important'); // Blue color for own selected card
                btn.style.setProperty('border-color', '#00c8ff', 'important');
                btn.style.setProperty('color', 'white', 'important');
            }
        });
        
        const status = document.getElementById('confirmation-status');
        if (status) {
            status.textContent = `ካርድ #${selectedCardId} ተመርጧል! ጨዋታው እስኪጀምር ይጠብቁ...`;
        }
        
        // Notify server
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: 'confirm_card',
                cardId: selectedCardId,
                stake: currentStake
            }));
        }
        
        hideCardPreview();
    }
}

document.addEventListener('DOMContentLoaded', function() {
    const backBtn = document.getElementById('preview-back-btn');
    const confirmPreviewBtn = document.getElementById('preview-confirm-btn');
    
    if (backBtn) {
        backBtn.addEventListener('click', hideCardPreview);
    }
    
    if (confirmPreviewBtn) {
        confirmPreviewBtn.addEventListener('click', confirmPreviewCard);
    }
});

function renderPlayerCard(cardId) {
    const cardContainer = document.getElementById('player-bingo-card');
    if (!cardContainer) return;
    
    const cardData = BINGO_CARDS[cardId];
    if (!cardData) return;
    
    cardContainer.innerHTML = '';
    
    cardData.forEach((row, rowIndex) => {
        row.forEach((num, colIndex) => {
            const cell = document.createElement('div');
            cell.className = 'player-card-cell';
            cell.dataset.number = num;
            
            if (rowIndex === 2 && colIndex === 2) {
                cell.classList.add('free-space', 'marked');
                cell.textContent = '★';
            } else {
                cell.textContent = num;
            }
            
            cell.addEventListener('click', function() {
                if (num !== 0) {
                    this.classList.toggle('marked');
                }
            });
            
            cardContainer.appendChild(cell);
        });
    });
}

function initializeUser() {
    try {
        if (window.Telegram && window.Telegram.WebApp) {
            const tg = window.Telegram.WebApp;
            tg.ready();
            tg.expand();
            
            if (tg.initDataUnsafe && tg.initDataUnsafe.user && tg.initDataUnsafe.user.id) {
                currentUserId = tg.initDataUnsafe.user.id;
                console.log('Telegram user ID:', currentUserId);
            } else {
                const urlParams = new URLSearchParams(window.location.search);
                const tgId = urlParams.get('tg_id');
                if (tgId) {
                    currentUserId = parseInt(tgId);
                    console.log('Telegram ID from URL:', currentUserId);
                } else {
                    currentUserId = null;
                    console.log('No Telegram user ID available');
                }
            }
        } else {
            const urlParams = new URLSearchParams(window.location.search);
            const tgId = urlParams.get('tg_id');
            if (tgId) {
                currentUserId = parseInt(tgId);
                console.log('Telegram ID from URL:', currentUserId);
            } else {
                currentUserId = null;
                console.log('Telegram WebApp not available');
            }
        }
    } catch (error) {
        console.error('Error initializing user:', error);
        currentUserId = null;
    }
}

function copyToClipboard(elementId) {
    const el = document.getElementById(elementId);
    if (!el) return;
    
    const text = el.textContent;
    if (!text || text === '---') return;

    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(() => {
            showToast('ተገልብጧል (Copied!)');
        }).catch(err => {
            console.error('Copy failed:', err);
        });
    } else {
        const textArea = document.createElement("textarea");
        textArea.value = text;
        document.body.appendChild(textArea);
        textArea.select();
        try {
            document.execCommand('copy');
            showToast('ተገልብጧል (Copied!)');
        } catch (err) {
            console.error('Fallback copy failed:', err);
        }
        document.body.removeChild(textArea);
    }
}

async function loadWallet() {
    if (!currentUserId) {
        console.log('No user ID, skipping wallet load');
        updateWalletDisplay(0);
        return;
    }
    
    try {
        const response = await fetch(`/api/wallet/${currentUserId}`);
        const data = await response.json();
        
        const balance = data.balance || 0;
        updateWalletDisplay(balance);
        
        const profileBalance = document.getElementById('profile-balance');
        if (profileBalance) profileBalance.textContent = `${parseFloat(balance).toFixed(2)} ETB`;
        
        const walletBalanceDisplay = document.getElementById('wallet-balance-value');
        if (walletBalanceDisplay) walletBalanceDisplay.textContent = parseFloat(balance).toFixed(2);
        
        loadTransactions();
    } catch (error) {
        console.error('Error loading wallet:', error);
        updateWalletDisplay(0);
    }
}

async function loadTransactions() {
    if (!currentUserId) return;
    
    try {
        const response = await fetch(`/api/transactions/${currentUserId}`);
        const data = await response.json();
        
        const list = document.getElementById('transaction-list');
        if (!list) return;
        
        if (!data.transactions || data.transactions.length === 0) {
            list.innerHTML = '<div class="no-transactions">No transactions yet</div>';
            return;
        }
        
        list.innerHTML = data.transactions.map(tx => `
            <div class="transaction-item">
                <div class="tx-info">
                    <span class="tx-type ${tx.type}">${tx.type.toUpperCase()}</span>
                    <span class="tx-date">${new Date(tx.created_at).toLocaleDateString()}</span>
                </div>
                <div class="tx-amount ${tx.type === 'deposit' ? 'positive' : 'negative'}">
                    ${tx.type === 'deposit' ? '+' : '-'}${parseFloat(tx.amount).toFixed(2)}
                </div>
                <div class="tx-status ${tx.status}">${tx.status}</div>
            </div>
        `).join('');
    } catch (error) {
        console.error('Error loading transactions:', error);
    }
}

function updateWalletDisplay(balance) {
    const walletElement = document.getElementById('main-wallet-value');
    if (walletElement) {
        walletElement.textContent = parseFloat(balance).toFixed(2);
    }
}

function showGameInProgressOverlay(count) {
    let overlay = document.getElementById('game-progress-overlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'game-progress-overlay';
        overlay.style.cssText = 'position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.85); display: flex; flex-direction: column; align-items: center; justify-content: center; z-index: 10001; color: white; text-align: center; padding: 20px; font-family: sans-serif;';
        overlay.innerHTML = `
            <h2 style="color: #ffcc00; margin-bottom: 15px;">ጨዋታ እየተካሄደ ነው</h2>
            <p id="progress-player-count" style="font-size: 1.2em; margin-bottom: 25px;">${count} ተጫዋቾች እየተጫወቱ ነው</p>
            <div style="display: flex; gap: 15px;">
                <button id="watch-game-btn" style="padding: 12px 30px; background: #00c8ff; border: none; border-radius: 8px; color: white; font-weight: bold; cursor: pointer;">ተመልከት (Watch)</button>
            </div>
        `;
        document.body.appendChild(overlay);
        
        document.getElementById('watch-game-btn').onclick = () => {
            overlay.style.display = 'none';
            const landing = document.getElementById('landing-screen');
            const game = document.getElementById('game-screen');
            if (landing) landing.style.display = 'none';
            if (game) game.style.display = 'flex';
        };
    } else {
        const countEl = document.getElementById('progress-player-count');
        if (countEl) countEl.textContent = `${count} ተጫዋቾች እየተጫወቱ ነው`;
        overlay.style.display = 'flex';
    }
}

function initializeWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}`;
    
    ws = new WebSocket(wsUrl);
    
    ws.onopen = function() {
        console.log('WebSocket connected');
        if (currentUserId && currentUserId !== 999999) {
            ws.send(JSON.stringify({
                type: 'auth_telegram',
                telegramId: currentUserId.toString(),
                username: 'Player_' + currentUserId
            }));
        }
    };
    
    ws.onmessage = function(event) {
        try {
            const data = JSON.parse(event.data);
            handleWebSocketMessage(data);
        } catch (error) {
            console.error('Error parsing WebSocket message:', error);
        }
    };
    
    ws.onclose = function() {
        console.log('WebSocket disconnected');
        setTimeout(initializeWebSocket, 3000);
    };
    
    ws.onerror = function(error) {
        console.error('WebSocket error:', error);
    };
}

function updateTimerDisplay(seconds) {
    const timerElement = document.getElementById('time-left');
    if (timerElement) {
        timerElement.textContent = `${seconds}s`;
    }
    
    // Also update selection timer if visible
    const selectionTimer = document.getElementById('selection-timer-container');
    if (selectionTimer) {
        selectionTimer.textContent = `ጨዋታው ለመጀመር ${seconds} ሰከንድ ቀርቷል...`;
    }
}

function updateGameStats(data) {
    if (data.participantsCount !== undefined) {
        const playerCount = document.getElementById('player-count');
        if (playerCount) playerCount.textContent = data.participantsCount;
        
        const activePlayersCount = document.getElementById('active-players-count');
        if (activePlayersCount) activePlayersCount.textContent = data.participantsCount;
    }
    if (data.totalJackpot !== undefined) {
        const prizePool = document.getElementById('prize-pool');
        if (prizePool) prizePool.textContent = `${parseFloat(data.totalJackpot).toFixed(2)}Br`;
        
        const activeJackpot = document.getElementById('active-jackpot-amount');
        if (activeJackpot) activeJackpot.textContent = `${parseFloat(data.totalJackpot).toFixed(2)}Br`;
    }
    if (data.stake !== undefined) {
        const gameStake = document.getElementById('game-stake');
        if (gameStake) gameStake.textContent = `${parseFloat(data.stake).toFixed(2)}Br`;
    }
    
    // Always show the banner as requested, even with 0 values
    const banner = document.getElementById('active-game-banner');
    if (banner) {
        banner.style.display = 'block';
    }
}

function handleWebSocketMessage(data) {
    // Update stats for any message that carries them
    updateGameStats(data);

    if (data.type === 'wallet_update') {
        updateWalletDisplay(data.balance);
        return;
    }

    if (data.type === 'error') {
        showToast(data.message);
        if (data.message.includes('ባላንስ') || data.message.includes('ቅነሳ')) {
            console.log('[DEBUG] Insufficient balance error received, resetting selection');
            selectedCardId = null;
            previewCardId = null;
            cardConfirmed = false;
            
            // Re-render the selection grid to clear highlights
            if (document.getElementById('selection-screen').style.display !== 'none') {
                generateCardSelection();
            }
            
            const status = document.getElementById('confirmation-status');
            if (status) status.textContent = '';
        }
        return;
    }

    switch (data.type) {
        case 'game_cancelled':
            showToast(data.message);
            updateWalletDisplay(data.balance);
            resetGameUI();
            break;
        case 'timer_update':
            updateTimerDisplay(data.timeLeft);
            updatePhaseDisplay(data.phase);
            
            // Log to console for debugging
            console.log('Timer update received:', data.timeLeft, 'Phase:', data.phase);
            
            // Show selection countdown if in selection phase
            if (data.phase === 'selection') {
                const timerContainer = document.getElementById('selection-timer-container');
                if (timerContainer) {
                    timerContainer.textContent = `ጨዋታው ለመጀመር ${data.timeLeft} ሰከንድ ቀርቷል...`;
                    timerContainer.style.display = 'block';
                }
            } else {
                const timerContainer = document.getElementById('selection-timer-container');
                if (timerContainer) timerContainer.style.display = 'none';
            }

            // Sync main game timer display if exists
            const timeLeftEl = document.getElementById('time-left');
            if (timeLeftEl) {
                timeLeftEl.textContent = `${data.timeLeft}s`;
            }
            
            if (data.participantsCount !== undefined) {
                const playerCount = document.getElementById('player-count');
                if (playerCount) playerCount.textContent = data.participantsCount;
            }
            if (data.totalJackpot !== undefined) {
                const prizePool = document.getElementById('prize-pool');
                if (prizePool) prizePool.textContent = `${parseFloat(data.totalJackpot).toFixed(2)}Br`;
            }

            // Force transition if time is up and we receive game phase
            if (data.timeLeft <= 0 && data.phase === 'game') {
                handlePhaseChange({ phase: 'game' });
            } else if (data.timeLeft <= 0 && data.phase === 'selection') {
                // Proactively show the game screen if a card is already selected
                if (selectedCardId && cardConfirmed) {
                    handlePhaseChange({ phase: 'game' });
                }
            }
            break;
        case 'init':
            console.log('Game initialized:', data);
            updateTimerDisplay(data.timeLeft);
            updatePhaseDisplay(data.phase);
            renderMasterGrid();
            
            // Show overlay if game is already in progress
            if (data.phase === 'game') {
                showGameInProgressOverlay(data.participantsCount || 0);
            }
            
            // Handle taken cards
            if (data.takenCards) {
                updateTakenCards(data.takenCards);
            }
            if (data.gameId) {
                const stakeEl = document.getElementById('game-stake');
                if (stakeEl) stakeEl.textContent = `${parseFloat(data.stake || 10).toFixed(2)}Br`;
            }
            
            if (data.participantsCount !== undefined) {
                const playerCount = document.getElementById('player-count');
                if (playerCount) playerCount.textContent = data.participantsCount;
            }
            if (data.totalJackpot !== undefined) {
                const prizePool = document.getElementById('prize-pool');
                if (prizePool) prizePool.textContent = `${parseFloat(data.totalJackpot).toFixed(2)}Br`;
            }

            if (data.calledNumbers && data.calledNumbers.length > 0) {
                data.calledNumbers.forEach((num, index) => {
                    markCalledNumber(num);
                    markMasterNumber(num);
                    if (index === data.calledNumbers.length - 1) {
                        displayCalledNumber(getLetterForNumber(num), num);
                    }
                });
                const calledCountEl = document.getElementById('called-count');
                if (calledCountEl) calledCountEl.textContent = `${data.calledNumbers.length}/75`;
            }
            break;
        case 'number_called':
            console.log('Number called:', data.letter + data.number);
            displayCalledNumber(data.letter, data.number);
            markCalledNumber(data.number);
            markMasterNumber(data.number);
            
            // Update called count
            if (data.calledNumbers) {
                const calledCountEl = document.getElementById('called-count');
                if (calledCountEl) calledCountEl.textContent = `${data.calledNumbers.length}/75`;
            }
            break;
        case 'game_over':
            console.log('Game Over event');
            resetGameUI();
            // ✅ Update wallet balance immediately after game over
            loadWallet();
            break;
        case 'winner_declared':
            console.log('Winner declared:', data.winner);
            showWinnerDisplay(data.winner);
            // ✅ Update wallet balance immediately if there's a winner
            loadWallet();
            break;
        case 'card_confirmed':
            updateWalletDisplay(data.balance);
            break;
        case 'phase_change':
            console.log('Phase changed:', data.phase);
            updatePhaseDisplay(data.phase);
            handlePhaseChange(data);
            
            if (data.participantsCount !== undefined) {
                const playerCount = document.getElementById('player-count');
                if (playerCount) playerCount.textContent = data.participantsCount;
            }
            if (data.totalJackpot !== undefined) {
                const prizePool = document.getElementById('prize-pool');
                if (prizePool) prizePool.textContent = `${parseFloat(data.totalJackpot).toFixed(2)}Br`;
            }
            break;
        case 'error':
            alert(data.error || 'ችግር ተፈጥሯል');
            break;
        case 'bingo_rejected':
            showBingoError(data.error || 'ምንም የማሸነፊያ መስመር የልዎትም');
            break;
        case 'card_taken':
            markCardAsTaken(data.cardId);
            break;
        default:
            console.log('Unknown message type:', data.type);
    }
}

let calledNumbersSet = new Set();

function getPatternName(type) {
    const names = {
        'row': 'አግዳሚ መስመር',
        'column': 'ቁልቁል መስመር',
        'diagonal': 'ዲያጎናል መስመር',
        'corners': 'አራቱም ማዕዘን'
    };
    return names[type] || 'ቢንጎ';
}

function highlightWinningPattern(cardId, pattern) {
    const cardContainer = document.getElementById('player-bingo-card');
    const winnerCardContainer = document.getElementById('winner-card-display');
    
    // Function to apply highlight to a container's cells
    const applyHighlight = (container, cardIdToRender) => {
        if (!container) return;
        
        const cardData = BINGO_CARDS[cardIdToRender];
        if (!cardData) return;
        
        container.innerHTML = '';
        cardData.forEach((row, rowIndex) => {
            row.forEach((num, colIndex) => {
                const cell = document.createElement('div');
                cell.className = 'player-card-cell';
                const cellIndex = rowIndex * 5 + colIndex;
                
                if (rowIndex === 2 && colIndex === 2) {
                    cell.classList.add('free-space', 'marked');
                    cell.textContent = '★';
                } else {
                    cell.textContent = num;
                    if (calledNumbersSet && calledNumbersSet.has(num)) {
                        cell.classList.add('marked');
                    }
                }
                
                // Highlight if part of winning pattern
                if (pattern.indices.includes(cellIndex)) {
                    cell.classList.add('winning-cell');
                    cell.style.backgroundColor = '#ffd700'; // Gold color
                    cell.style.color = '#000';
                    cell.style.transform = 'scale(1.1)';
                    cell.style.boxShadow = '0 0 15px #ffd700';
                    cell.style.zIndex = '1';
                }
                
                container.appendChild(cell);
            });
        });
    };

    // Show winner's card in the overlay
    if (winnerCardContainer) {
        applyHighlight(winnerCardContainer, cardId);
    }
    
    // If current player is the winner, highlight their card too
    if (cardId === selectedCardId) {
        applyHighlight(cardContainer, cardId);
    }
}

function showGameStartNotification() {
    let overlay = document.getElementById('game-start-notif');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'game-start-notif';
        overlay.className = 'game-start-overlay';
        overlay.innerHTML = `
            <div class="game-start-content">
                <div class="game-start-text">ጨዋታው ተጀምሯል! 🎮</div>
            </div>
        `;
        document.body.appendChild(overlay);
    }
    overlay.style.display = 'block';
    setTimeout(() => {
        overlay.style.display = 'none';
    }, 3000);
}

function handlePhaseChange(data) {
    console.log('--- Phase Change ---', data.phase);
    currentPhase = data.phase;
    
    const gameScreen = document.getElementById('game-screen');
    const selectionScreen = document.getElementById('selection-screen');
    const landingScreen = document.getElementById('landing-screen');
    const profileScreen = document.getElementById('profile-screen');
    const walletScreen = document.getElementById('wallet-screen');
    
    // Hide all main screens
    if (gameScreen) gameScreen.style.display = 'none';
    if (selectionScreen) selectionScreen.style.display = 'none';
    if (landingScreen) landingScreen.style.display = 'none';
    if (profileScreen) profileScreen.style.display = 'none';
    if (walletScreen) walletScreen.style.display = 'none';
    
    if (data.phase === 'selection') {
        // Clear previous game data
        clearCallHistory();
        clearMasterGrid();
        calledNumbersSet.clear();
        selectedCardId = null;
        cardConfirmed = false;
        
        // Clear player card marks
        const playerCells = document.querySelectorAll('.player-card-cell');
        playerCells.forEach(cell => cell.classList.remove('called', 'marked'));
        
        if (selectionScreen) {
            selectionScreen.style.display = 'flex';
            generateCardSelection();
            const status = document.getElementById('confirmation-status');
            if (status) status.textContent = 'ካርድ ይምረጡ';
        }
    } else if (data.phase === 'game') {
        showGameStartNotification();
        if (gameScreen) {
            gameScreen.style.display = 'flex';
            if (selectedCardId) {
                renderPlayerCard(selectedCardId);
                const activeTag = document.querySelector('.active-tag');
                if (activeTag) {
                    activeTag.textContent = `የእርስዎ ካርድ #${selectedCardId}`;
                }
                const gameStatusBox = document.querySelector('.game-status-box');
                if (gameStatusBox) {
                    gameStatusBox.style.display = 'none';
                }
            } else {
                const cardContainer = document.getElementById('player-bingo-card');
                if (cardContainer) cardContainer.innerHTML = '<div style="text-align:center; padding:20px; color:#aaa;">WATCHING ONLY</div>';
                const gameStatusBox = document.querySelector('.game-status-box');
                if (gameStatusBox) {
                    gameStatusBox.style.display = 'flex';
                }
            }
        }
        renderMasterGrid();
    } else if (data.phase === 'winner') {
        if (data.winner) {
            showWinnerDisplay(data.winner);
        }
    }
    updateBackButtonVisibility();
}

function showBingoError(message) {
    let overlay = document.getElementById('bingo-modal-overlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'bingo-modal-overlay';
        overlay.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 0, 0, 0.85);
            display: flex;
            justify-content: center;
            align-items: center;
            z-index: 20000;
            backdrop-filter: blur(8px);
            -webkit-backdrop-filter: blur(8px);
        `;
        document.body.appendChild(overlay);
    }

    overlay.innerHTML = `
        <div style="
            background: #1c2235;
            width: 85%;
            max-width: 320px;
            padding: 30px 20px;
            border-radius: 24px;
            border: 2px solid #ff4757;
            text-align: center;
            box-shadow: 0 0 40px rgba(255, 71, 87, 0.3);
            animation: modalPop 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275);
        ">
            <div style="
                width: 60px;
                height: 60px;
                background: rgba(255, 71, 87, 0.1);
                border-radius: 50%;
                display: flex;
                align-items: center;
                justify-content: center;
                margin: 0 auto 20px;
            ">
                <span style="font-size: 30px; color: #ff4757;">⚠️</span>
            </div>
            <h2 style="color: #fff; margin-bottom: 10px; font-size: 1.4em;">ይቅርታ</h2>
            <p style="color: #8890a6; line-height: 1.5; margin-bottom: 25px; font-size: 1.1em;">
                ${message}
            </p>
            <button onclick="document.getElementById('bingo-modal-overlay').style.display='none'" style="
                background: #ff4757;
                color: #fff;
                border: none;
                padding: 12px 40px;
                border-radius: 12px;
                font-weight: 800;
                font-size: 1em;
                cursor: pointer;
                box-shadow: 0 5px 15px rgba(255, 71, 87, 0.4);
                transition: transform 0.2s;
            " onactive="this.style.transform='scale(0.95)'">እሺ</button>
        </div>
    `;
    
    // Add animation if not present
    if (!document.getElementById('modal-animations')) {
        const style = document.createElement('style');
        style.id = 'modal-animations';
        style.textContent = `
            @keyframes modalPop {
                from { opacity: 0; transform: scale(0.8); }
                to { opacity: 1; transform: scale(1); }
            }
        `;
        document.head.appendChild(style);
    }

    overlay.style.display = 'flex';
}

function showWinnerDisplay(winner) {
    const isMe = winner.userId === currentUserId; // Changed from telegramId to userId comparison
    
    let overlay = document.getElementById('bingo-modal-overlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'bingo-modal-overlay';
        overlay.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 0, 0, 0.85);
            display: flex;
            justify-content: center;
            align-items: center;
            z-index: 20000;
            backdrop-filter: blur(8px);
            -webkit-backdrop-filter: blur(8px);
        `;
        document.body.appendChild(overlay);
    }

    const borderColor = isMe ? '#00d984' : '#a855f7';
    const icon = isMe ? '🏆' : '🎉';
    const title = isMe ? 'እንኳን ደስ አለዎት!' : 'አሸናፊ ተገኝቷል!';
    const actionColor = isMe ? '#00d984' : '#a855f7';

    overlay.innerHTML = `
        <div style="
            background: #1c2235;
            width: 85%;
            max-width: 320px;
            padding: 20px;
            border-radius: 24px;
            border: 2px solid ${borderColor};
            text-align: center;
            box-shadow: 0 0 40px ${borderColor}33;
            animation: modalPop 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275);
        ">
            <div style="
                width: 60px;
                height: 60px;
                background: ${borderColor}1a;
                border-radius: 50%;
                display: flex;
                align-items: center;
                justify-content: center;
                margin: 0 auto 15px;
            ">
                <span style="font-size: 30px;">${icon}</span>
            </div>
            <h2 style="color: #fff; margin-bottom: 5px; font-size: 1.4em;">${title}</h2>
            <div style="color: #8890a6; line-height: 1.4; margin-bottom: 20px;">
                <p style="font-size: 1.1em; color: #fff; font-weight: 800; margin-bottom: 5px;">${winner.username}</p>
                ${winner.phoneNumber && winner.phoneNumber !== '---' ? `<p style="font-size: 0.9em; color: #00f2ff; margin-bottom: 5px;">Phone: ${winner.phoneNumber}</p>` : ''}
                <p>ካርድ: #${winner.cardId}</p>
                <p style="color: #ffd700; font-size: 1.2em; font-weight: 800; margin-top: 10px;">ሽልማት: ${winner.prize || 0} ብር</p>
                <div id="winner-card-display" class="player-game-card" style="width: 150px; height: 150px; margin: 15px auto; font-size: 0.6em; gap: 2px;"></div>
            </div>
            <div id="return-countdown" class="return-timer">ወደ ካርድ መምረጫ ለመመለስ 5 ሰከንድ ቀርቷል...</div>
        </div>
    `;

    overlay.style.display = 'flex';
    
    // Highlight winning pattern on the small card display
    if (winner.pattern) {
        highlightWinningPattern(winner.cardId, winner.pattern);
    }

    // Start 5 second countdown
    let timeLeft = 5;
    const countdownEl = document.getElementById('return-countdown');
    const interval = setInterval(() => {
        timeLeft--;
        if (countdownEl) {
            countdownEl.textContent = `ወደ ካርድ መምረጫ ለመመለስ ${timeLeft} ሰከንድ ቀርቷል...`;
        }
        if (timeLeft <= 0) {
            clearInterval(interval);
            overlay.style.display = 'none';
            // Return to selection screen
            const gameScreen = document.getElementById('game-screen');
            const selectionScreen = document.getElementById('selection-screen');
            if (gameScreen) gameScreen.style.display = 'none';
            if (selectionScreen) selectionScreen.style.display = 'flex';
            cardConfirmed = false;
            selectedCardId = null;
            generateCardSelection();
            updateBackButtonVisibility();
        }
    }, 1000);

    if (isMe && typeof confetti === 'function') {
        // ... (confetti code remains same)

        const duration = 5 * 1000;
        const animationEnd = Date.now() + duration;
        const defaults = { startVelocity: 30, spread: 360, ticks: 60, zIndex: 30000 };

        const randomInRange = (min, max) => Math.random() * (max - min) + min;

        const interval = setInterval(function() {
            const timeLeft = animationEnd - Date.now();
            if (timeLeft <= 0) return clearInterval(interval);

            const particleCount = 50 * (timeLeft / duration);
            confetti({ ...defaults, particleCount, origin: { x: randomInRange(0.1, 0.3), y: Math.random() - 0.2 } });
            confetti({ ...defaults, particleCount, origin: { x: randomInRange(0.7, 0.9), y: Math.random() - 0.2 } });
        }, 250);
    }
}

function renderMasterGrid() {
    const masterGrid = document.getElementById('master-grid');
    if (!masterGrid) return;
    
    masterGrid.innerHTML = '';
    
    // Create 5 columns x 15 rows (75 numbers)
    for (let row = 0; row < 15; row++) {
        for (let col = 0; col < 5; col++) {
            const num = col * 15 + row + 1;
            const cell = document.createElement('div');
            cell.className = 'master-cell';
            cell.dataset.number = num;
            cell.textContent = num;
            masterGrid.appendChild(cell);
        }
    }
}

function markMasterNumber(number) {
    const masterGrid = document.getElementById('master-grid');
    if (!masterGrid) return;
    
    const cells = masterGrid.querySelectorAll('.master-cell');
    cells.forEach(cell => {
        cell.classList.remove('last-called');
        if (parseInt(cell.dataset.number) === number) {
            cell.classList.add('called', 'last-called');
        }
    });
}

function clearMasterGrid() {
    const masterGrid = document.getElementById('master-grid');
    if (!masterGrid) return;
    
    const cells = masterGrid.querySelectorAll('.master-cell');
    cells.forEach(cell => cell.classList.remove('called', 'last-called'));
}

function displayCalledNumber(letter, number) {
    const lastLetterEl = document.getElementById('last-letter');
    const lastNumberEl = document.getElementById('last-number');
    const prev1 = document.getElementById('prev-called-1');
    const prev2 = document.getElementById('prev-called-2');
    
    if (lastLetterEl && lastNumberEl) {
        const currentLetter = lastLetterEl.textContent;
        const currentNumber = lastNumberEl.textContent;
        
        // Shift current to history
        if (currentLetter && currentNumber && currentNumber !== '--') {
            if (prev1) {
                if (prev2) prev2.textContent = prev1.textContent;
                prev1.textContent = currentLetter + currentNumber;
            }
        }
        
        lastLetterEl.textContent = letter;
        lastNumberEl.textContent = number;
        
        // Add animation class
        const ball = document.getElementById('last-called-ball');
        if (ball) {
            ball.classList.remove('new-call');
            void ball.offsetWidth; // trigger reflow
            ball.classList.add('new-call');
        }
    }
}

function getLetterForNumber(number) {
    if (number <= 15) return 'B';
    if (number <= 30) return 'I';
    if (number <= 45) return 'N';
    if (number <= 60) return 'G';
    return 'O';
}

function clearCallHistory() {
    const lastLetterEl = document.getElementById('last-letter');
    const lastNumberEl = document.getElementById('last-number');
    const prev1 = document.getElementById('prev-called-1');
    const prev2 = document.getElementById('prev-called-2');
    
    if (lastLetterEl) lastLetterEl.textContent = '';
    if (lastNumberEl) lastNumberEl.textContent = '--';
    if (prev1) prev1.textContent = '';
    if (prev2) prev2.textContent = '';
}

function updateTimerDisplay(timeLeft) {
    const timerElement = document.getElementById('time-left');
    if (timerElement) {
        timerElement.textContent = timeLeft + 's';
    }
}

function updatePhaseDisplay(phase) {
    const phaseElement = document.getElementById('game-phase');
    if (phaseElement) {
        if (phase === 'selection') {
            phaseElement.textContent = 'ካርድ ይምረጡ';
        } else if (phase === 'game') {
            phaseElement.textContent = 'ጨዋታ በሂደት ላይ';
        } else if (phase === 'winner') {
            phaseElement.textContent = 'አሸናፊ!';
        }
    }
}

function markCalledNumber(number) {
    calledNumbersSet.add(number);
    
    const cells = document.querySelectorAll('.player-card-cell');
    cells.forEach(cell => {
        if (parseInt(cell.dataset.number) === number) {
            cell.classList.add('called');
        }
    });
}

// Bingo button functionality
function initializeBingoButton() {
    const bingoBtn = document.getElementById('bingo-btn');
    if (bingoBtn) {
        bingoBtn.addEventListener('click', function() {
            claimBingo();
        });
    }
}

function claimBingo() {
    console.log('claimBingo called, selectedCardId:', selectedCardId);
    if (!selectedCardId) {
        alert('ካርድ አልመረጡም');
        return;
    }
    
    // Check both ws and socket variables
    const currentSocket = (typeof ws !== 'undefined' && ws) || (typeof socket !== 'undefined' && socket);
    
    if (currentSocket && currentSocket.readyState === WebSocket.OPEN) {
        console.log('Sending claim_bingo for card:', selectedCardId);
        currentSocket.send(JSON.stringify({
            type: 'claim_bingo',
            cardId: selectedCardId
        }));
    } else {
        console.error('WebSocket not connected', { 
            wsExists: typeof ws !== 'undefined', 
            socketExists: typeof socket !== 'undefined',
            readyState: currentSocket ? currentSocket.readyState : 'no socket'
        });
        alert('ከኢንተርኔት ጋር አልተገናኙም፣ እባክዎ ገጹን ሪፍሬሽ ያድርጉ');
    }
}

function refreshBalance() {
    loadWallet();
}

window.refreshBalance = refreshBalance;
window.claimBingo = claimBingo;
