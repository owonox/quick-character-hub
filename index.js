// ========================================
// 角色速切插件 v2.4 - 最终修复版
// ========================================

import { getContext, extension_settings } from '../../../extensions.js';
import { tag_map, tags } from '../../../tags.js';

// ============ 插件配置 ============
const DEFAULT_SETTINGS = {
    gridColumns: 5,
    sortMethod: 'created',
    sortOrder: 'desc',
    filterFav: 'all',
    filterTag: '',
    pageSize: 60,
};

// ============ 全局状态 ============
let pluginSettings = { ...DEFAULT_SETTINGS };
let allCharacters = [];
let allTags = [];
let characterChatsCache = {};
let currentPage = 1;
let currentSortedCharacters = [];
let currentView = 'main';
let currentDetailChar = null;
let isAnalyzing = false;

// ============ 工具函数 ============

function debounce(func, wait) {
    let timeout;
    return function(...args) {
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(this, args), wait);
    };
}

// ============ API 调用函数 ============

function fetchAllCharacters() {
    try {
        const context = getContext();
        if (context.characters && context.characters.length > 0) {
            allCharacters = [...context.characters];
            return allCharacters;
        }
    } catch (error) {
        console.error('[角色速切] 获取角色失败:', error);
    }
    return [];
}

function fetchAllTags() {
    try {
        const context = getContext();
        if (context.tags && Array.isArray(context.tags)) {
            allTags = [...context.tags];
            return allTags;
        }
    } catch (error) {
        console.error('[角色速切] 获取标签失败:', error);
    }
    return [];
}

async function fetchCharacterChats(avatarFileName) {
    if (!avatarFileName) return [];
    if (characterChatsCache[avatarFileName]) {
        return characterChatsCache[avatarFileName];
    }
    
    return new Promise((resolve) => {
        $.ajax({
            url: '/api/characters/chats',
            type: 'POST',
            contentType: 'application/json',
            data: JSON.stringify({ avatar_url: avatarFileName }),
            timeout: 5000,
            success: (data) => {
                const chats = Array.isArray(data) ? data : [];
                characterChatsCache[avatarFileName] = chats;
                resolve(chats);
            },
            error: (xhr, status) => {
                console.warn(`[角色速切] 获取 ${avatarFileName} 失败: ${status}`);
                characterChatsCache[avatarFileName] = [];
                resolve([]);
            }
        });
    });
}

async function preloadAllChatsInBackground() {
    const batchSize = 5;
    for (let i = 0; i < allCharacters.length; i += batchSize) {
        const batch = allCharacters.slice(i, i + batchSize);
        await Promise.all(batch.map(char => fetchCharacterChats(char.avatar)));
    }
}

// ============ 标签相关函数 ============

function getCharactersWithTag(tagId) {
    console.log('[角色速切] 查找标签:', tagId);
    const result = [];
    for (const [avatarName, tagIds] of Object.entries(tag_map)) {
        if (Array.isArray(tagIds) && tagIds.includes(tagId)) {
            const char = allCharacters.find(c => c.avatar === avatarName);
            if (char) result.push(char);
        }
    }
    return result;
}

// ============ 数据处理函数 ============
// ============ 数据处理函数 (修复版) ============

function getTotalMessageCount(chats) {
    if (!chats || !Array.isArray(chats)) return 0;
    return chats.reduce((total, chat) => {
        // 优先使用 chat_items (新版)，其次 message_count，最后 mes (如果它是数字)
        const count = chat.chat_items || chat.message_count || (typeof chat.mes === 'number' ? chat.mes : 0);
        return total + (parseInt(count) || 0);
    }, 0);
}

function getLastChatTime(chats) {
    if (!chats || chats.length === 0) return 0;
    return Math.max(...chats.map(chat => {
        // 尝试解析 last_mes (可能是时间戳，也可能是日期字符串)
        if (chat.last_mes) {
            const time = new Date(chat.last_mes).getTime();
            if (!isNaN(time)) return time;
        }
        return 0;
    }));
}

function getInteractionDays(chats) {
    if (!chats || chats.length === 0) return 0;
    const days = new Set();
    chats.forEach(chat => {
        if (chat.last_mes) {
            const date = new Date(chat.last_mes);
            if (!isNaN(date.getTime())) {
                days.add(date.toDateString());
            }
        }
    });
    return days.size;
}

function getMessagesInPeriod(chats, periodType) {
    if (!chats || chats.length === 0) return 0;
    const now = new Date();
    let startTime;
    
    switch (periodType) {
        case 'week': startTime = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000); break;
        case 'month': startTime = new Date(now.getFullYear(), now.getMonth() - 1, now.getDate()); break;
        case 'year': startTime = new Date(now.getFullYear() - 1, now.getMonth(), now.getDate()); break;
        default: return 0;
    }
    
    const startTimestamp = startTime.getTime();
    let total = 0;
    
    chats.forEach(chat => {
        let chatTime = 0;
        if (chat.last_mes) {
            chatTime = new Date(chat.last_mes).getTime();
        }
        
        if (chatTime >= startTimestamp) {
            const count = chat.chat_items || chat.message_count || (typeof chat.mes === 'number' ? chat.mes : 0);
            total += (parseInt(count) || 0);
        }
    });
    return total;
}

// ============ 排序和过滤 ============

async function sortCharacters(characters, method, order = 'desc') {
    const sorted = [...characters];
    switch (method) {
        case 'recent':
            sorted.sort((a, b) => {
                const chatsA = characterChatsCache[a.avatar] || [];
                const chatsB = characterChatsCache[b.avatar] || [];
                const timeA = chatsA.length > 0 ? getLastChatTime(chatsA) : (a.date_added || 0);
                const timeB = chatsB.length > 0 ? getLastChatTime(chatsB) : (b.date_added || 0);
                return timeB - timeA;
            });
            break;
        case 'alpha':
            sorted.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'zh-CN'));
            break;
        case 'created':
            sorted.sort((a, b) => (b.date_added || 0) - (a.date_added || 0));
            break;
        case 'messages':
            sorted.sort((a, b) => {
                const msgsA = getTotalMessageCount(characterChatsCache[a.avatar] || []);
                const msgsB = getTotalMessageCount(characterChatsCache[b.avatar] || []);
                return msgsB - msgsA;
            });
            break;
    }
    if (order === 'asc') sorted.reverse();
    return sorted;
}

function filterCharacters(characters, filterFav, filterTag) {
    let filtered = [...characters];
    if (filterFav === 'fav') {
        filtered = filtered.filter(char => char.fav === true || char.fav === 'true');
    } else if (filterFav === 'unfav') {
        filtered = filtered.filter(char => !char.fav || char.fav === 'false');
    }
    if (filterTag) {
        const tagChars = getCharactersWithTag(filterTag);
        filtered = filtered.filter(c => tagChars.some(tc => tc.avatar === c.avatar));
    }
    return filtered;
}

// ============ 排行榜函数 ============

function getRandomCharacter() {
    if (allCharacters.length === 0) return null;
    return allCharacters[Math.floor(Math.random() * allCharacters.length)];
}

async function getTopInteractionDaysCharacters(count = 5) {
    const results = [];
    for (const char of allCharacters) {
        const chats = characterChatsCache[char.avatar] || [];
        const days = getInteractionDays(chats);
        if (days > 0) results.push({ character: char, days });
    }
    results.sort((a, b) => b.days - a.days);
    return results.slice(0, count);
}

async function getTopFavoriteCharacters(periodType, count = 5) {
    const results = [];
    for (const char of allCharacters) {
        const chats = characterChatsCache[char.avatar] || [];
        const messages = getMessagesInPeriod(chats, periodType);
        if (messages > 0) results.push({ character: char, messages });
    }
    results.sort((a, b) => b.messages - a.messages);
    return results.slice(0, count);
}

async function getTopMessageCountCharacters(count = 5) {
    const results = [];
    for (const char of allCharacters) {
        const chats = characterChatsCache[char.avatar] || [];
        const total = getTotalMessageCount(chats);
        if (total > 0) results.push({ character: char, total });
    }
    results.sort((a, b) => b.total - a.total);
    return results.slice(0, count);
}

// ============ 面板显示控制 ============

function showPanel(panelId) {
    document.getElementById('qc-panel').style.display = 'none';
    document.getElementById('qc-detail-panel').style.display = 'none';
    document.getElementById('qc-worldbook-panel').style.display = 'none';
    document.getElementById('qc-ranking-panel').style.display = 'none';
    document.getElementById(panelId).style.display = 'flex';
}

// ============ 第一个界面：主面板 ============

function createMainPanelHTML() {
    let tagOptions = '<option value="">全部角色</option>';
    allTags.forEach(tag => {
        tagOptions += `<option value="${tag.id}">${tag.name}</option>`;
    });
    
    return `
    <div id="qc-overlay" class="qc-overlay">
        <div id="qc-panel" class="qc-panel">
            <div class="qc-toolbar">
                <div class="qc-toolbar-left">
                    <div class="qc-tool-btn ${pluginSettings.filterFav === 'fav' ? 'active' : ''}" id="qc-fav-btn" title="收藏">⭐</div>
                    <div class="qc-tool-btn" id="qc-ranking-btn" title="排行榜">🏆</div>
                    <select id="qc-tag-filter" class="qc-select">${tagOptions}</select>
                </div>
                <div class="qc-toolbar-center">
                    <input type="text" id="qc-search" class="qc-search" placeholder="搜索角色...">
                </div>
                <div class="qc-toolbar-right">
                    <select id="qc-sort-method" class="qc-select">
                        <option value="created">创建时间</option>
                        <option value="recent">最近聊天</option>
                        <option value="alpha">字母顺序</option>
                        <option value="messages">聊天楼层</option>
                    </select>
                    <div class="qc-tool-btn" id="qc-sort-order" title="排序">↓</div>
                    <input type="number" id="qc-grid-columns" class="qc-input-mini" value="${pluginSettings.gridColumns}" min="3" max="10">
                    <div class="qc-tool-btn qc-close-btn" id="qc-close-btn">✕</div>
                </div>
            </div>
            <div class="qc-content" id="qc-content">
                <div class="qc-grid" id="qc-grid"></div>
                <div class="qc-pagination" id="qc-pagination"></div>
            </div>
            <div class="qc-loading" id="qc-loading"><div class="qc-spinner"></div></div>
        </div>
        <div id="qc-detail-panel" class="qc-side-panel"></div>
        <div id="qc-worldbook-panel" class="qc-side-panel"></div>
        <div id="qc-ranking-panel" class="qc-side-panel"></div>
    </div>
    `;
}

function renderCharacterCard(char) {
    const avatarUrl = char.avatar ? `/characters/${encodeURIComponent(char.avatar)}` : '/img/ai4.png';
    const isFav = char.fav === true || char.fav === 'true';
    return `
    <div class="qc-card" data-avatar="${char.avatar || ''}">
        <div class="qc-card-img">
            <img src="${avatarUrl}" loading="lazy" onerror="this.src='/img/ai4.png'">
            ${isFav ? '<i class="qc-fav">★</i>' : ''}
        </div>
        <div class="qc-card-name">${char.name || '未命名'}</div>
    </div>
    `;
}

async function renderCharacterGrid(page = 1) {
    const grid = document.getElementById('qc-grid');
    const loading = document.getElementById('qc-loading');
    if (!grid) return;
    
    loading.style.display = 'flex';
    grid.innerHTML = '';
    
    try {
        let characters = await sortCharacters(allCharacters, pluginSettings.sortMethod, pluginSettings.sortOrder);
        characters = filterCharacters(characters, pluginSettings.filterFav, pluginSettings.filterTag);
        
        const searchText = document.getElementById('qc-search')?.value?.toLowerCase() || '';
        if (searchText) {
            characters = characters.filter(char => (char.name || '').toLowerCase().includes(searchText));
        }
        
        currentSortedCharacters = characters;
        
        const pageSize = pluginSettings.pageSize;
        const totalPages = Math.ceil(characters.length / pageSize) || 1;
        currentPage = Math.min(page, totalPages) || 1;
        
        const startIdx = (currentPage - 1) * pageSize;
        const pageChars = characters.slice(startIdx, startIdx + pageSize);
        
        grid.style.gridTemplateColumns = `repeat(${pluginSettings.gridColumns}, 1fr)`;
        grid.innerHTML = pageChars.map(renderCharacterCard).join('');
        
        renderPagination(totalPages);
        bindCardEvents();
    } catch (error) {
        console.error('[角色速切] 渲染失败:', error);
        grid.innerHTML = '<div class="qc-empty">加载失败</div>';
    } finally {
        loading.style.display = 'none';
    }
}

function renderPagination(totalPages) {
    const pagination = document.getElementById('qc-pagination');
    if (!pagination) return;
    if (totalPages <= 1) {
        pagination.innerHTML = `<span class="qc-page-info">共 ${currentSortedCharacters.length} 个</span>`;
        return;
    }
    pagination.innerHTML = `
        <button class="qc-page-btn" data-page="${currentPage - 1}" ${currentPage === 1 ? 'disabled' : ''}>‹</button>
        <span class="qc-page-info">${currentPage}/${totalPages} (${currentSortedCharacters.length}个)</span>
        <button class="qc-page-btn" data-page="${currentPage + 1}" ${currentPage === totalPages ? 'disabled' : ''}>›</button>
    `;
    pagination.querySelectorAll('.qc-page-btn').forEach(btn => {
        btn.onclick = () => {
            const p = parseInt(btn.dataset.page);
            if (p && !btn.disabled) renderCharacterGrid(p);
        };
    });
}

function bindCardEvents() {
    document.querySelectorAll('.qc-card').forEach(card => {
        let clickCount = 0;
        let clickTimer = null;
        card.onclick = () => {
            clickCount++;
            if (clickCount === 1) {
                clickTimer = setTimeout(() => {
                    clickCount = 0;
                    const char = allCharacters.find(c => c.avatar === card.dataset.avatar);
                    if (char) renderDetailPanel(char);
                }, 280);
            } else if (clickCount === 2) {
                clearTimeout(clickTimer);
                clickCount = 0;
                const char = allCharacters.find(c => c.avatar === card.dataset.avatar);
                if (char) selectCharacterAndStartChat(char);
            }
        };
    });
}

// ============ 第二个界面：角色详情 ============

async function renderDetailPanel(char) {
    const panel = document.getElementById('qc-detail-panel');
    if (!panel) return;
    
    currentView = 'detail';
    currentDetailChar = char;
    showPanel('qc-detail-panel');
    
    const avatarUrl = char.avatar ? `/characters/${encodeURIComponent(char.avatar)}` : '/img/ai4.png';
    const isFav = char.fav === true || char.fav === 'true';
    const chats = await fetchCharacterChats(char.avatar);
    
    // 【关键修复】确保侧边栏列表不为空
    const sideList = currentSortedCharacters.length > 0 ? currentSortedCharacters : allCharacters;
    
    const description = char.description || char.data?.description || '';
    const firstMes = char.first_mes || char.data?.first_mes || '';
    
    panel.innerHTML = `
        <div class="qc-sidebar">
            <button class="qc-back-btn" id="qc-back">返回</button>
            <div class="qc-sidebar-list">
                ${sideList.map(c => `
                    <div class="qc-sidebar-item ${c.avatar === char.avatar ? 'active' : ''}" data-avatar="${c.avatar}">
                        <img src="/characters/${encodeURIComponent(c.avatar)}" onerror="this.src='/img/ai4.png'">
                    </div>
                `).join('')}
            </div>
        </div>
        
        <div class="qc-main">
            <div class="qc-detail-header">
                <img class="qc-detail-avatar" src="${avatarUrl}" onerror="this.src='/img/ai4.png'">
                <div class="qc-detail-info">
                    <h2>${char.name} ${isFav ? '<span class="qc-star">★</span>' : ''}</h2>
                    <div class="qc-detail-btns">
                        <button class="qc-btn qc-btn-primary" id="qc-start-chat">💬 聊天</button>
                        <button class="qc-btn" id="qc-worldbook-btn">📖 世界书</button>
                        <button class="qc-btn" id="qc-fav-toggle">${isFav ? '★ 已收藏' : '☆ 收藏'}</button>
                        <button class="qc-btn qc-btn-primary" id="qc-save-char">💾 保存</button>
                    </div>
                </div>
            </div>
            
            <div class="qc-detail-body">
                <div class="qc-edit-section">
                    <label>角色描述</label>
                    <textarea class="qc-edit-textarea" id="qc-edit-desc" rows="6">${description}</textarea>
                </div>
                
                <div class="qc-edit-section">
                    <label>开场白</label>
                    <textarea class="qc-edit-textarea" id="qc-edit-first" rows="4">${firstMes}</textarea>
                </div>
                
                <div class="qc-section">
                    <h3>聊天记录 (${chats.length})</h3>
                    <div class="qc-chat-list">
                        ${chats.length > 0 ? chats.map(chat => {
                            const lastDate = chat.last_mes ? new Date(chat.last_mes).toLocaleString('zh-CN', {
                                month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit'
                            }) : '';
                            return `
                                <div class="qc-chat-item" data-file="${chat.file_name}">
                                    <div class="qc-chat-name">${chat.file_name?.replace('.jsonl', '') || '未命名'}</div>
                                    <div class="qc-chat-meta">${chat.chat_items || chat.message_count || 0}条 · ${lastDate}</div>
                                </div>
                            `;
                        }).join('') : '<div class="qc-empty">暂无聊天记录</div>'}
                    </div>
                </div>
            </div>
        </div>
    `;
    
    bindDetailEvents(char);
}

function bindDetailEvents(char) {
    document.getElementById('qc-back').onclick = () => {
        showPanel('qc-panel');
        currentView = 'main';
    };
    
    document.querySelectorAll('#qc-detail-panel .qc-sidebar-item').forEach(item => {
        item.onclick = () => {
            const c = allCharacters.find(x => x.avatar === item.dataset.avatar);
            if (c) renderDetailPanel(c);
        };
    });
    
    document.getElementById('qc-start-chat').onclick = () => selectCharacterAndStartChat(char);
    document.getElementById('qc-worldbook-btn').onclick = () => renderWorldBookPanel(char);
    document.getElementById('qc-fav-toggle').onclick = () => toggleFavorite(char);
    
    document.getElementById('qc-save-char').onclick = async () => await saveCharacterEdits(char);
    
    document.querySelectorAll('.qc-chat-item').forEach(item => {
        item.onclick = () => selectCharacterAndStartChat(char);
    });
}

// ============ 保存和切换函数 ============

async function saveCharacterEdits(char) {
    try {
        const description = document.getElementById('qc-edit-desc')?.value || '';
        const first_mes = document.getElementById('qc-edit-first')?.value || '';
        
        // 更新内存对象
        char.description = description;
        char.first_mes = first_mes;
        if (char.data) {
            char.data.description = description;
            char.data.first_mes = first_mes;
        }
        
        // 更新实时 context
        const context = getContext();
        const liveChar = context.characters.find(c => c.avatar === char.avatar);
        if (liveChar) {
            liveChar.description = description;
            liveChar.first_mes = first_mes;
            if (liveChar.data) {
                liveChar.data.description = description;
                liveChar.data.first_mes = first_mes;
            }
        }
        
        const formData = new FormData();
        formData.append('avatar_url', char.avatar);
        formData.append('ch_name', char.name);
        
        // 所有字段全量覆盖
        const fields = ['description', 'first_mes', 'personality', 'scenario', 'mes_example', 'creator_notes', 'system_prompt', 'post_history_instructions', 'creator', 'character_version', 'tags'];
        fields.forEach(f => {
            let val = char[f] || char.data?.[f];
            if (typeof val === 'object') val = JSON.stringify(val);
            formData.append(f, val || '');
        });
        
        formData.append('extensions', JSON.stringify(char.data?.extensions || {}));
        
        if (char.data?.character_book) {
            formData.append('world', JSON.stringify(char.data.character_book));
        }
        
        await new Promise((resolve, reject) => {
            $.ajax({
                url: '/api/characters/edit',
                type: 'POST',
                data: formData,
                processData: false,
                contentType: false,
                success: resolve,
                error: (xhr) => reject(xhr.responseText)
            });
        });
        
        alert('保存成功！');
        
    } catch (e) {
        console.error('[角色速切] 保存失败:', e);
        alert('保存失败: ' + e);
    }
}

async function selectCharacterAndStartChat(char) {
    try {
        console.log('[角色速切] 目标:', char.name);
        const context = getContext();
        const idx = context.characters.findIndex(c => c.avatar === char.avatar);
        
        if (idx === -1) {
            alert('角色不存在');
            return;
        }

        closePanel();
        await new Promise(r => setTimeout(r, 100));

        // -----------------------------------------------------------
        // 方案 1: 直接调用内部函数 (最干净)
        // -----------------------------------------------------------
        // 很多版本的 ST 把这些函数挂在 window 上，或者 eventSource
        const funcs = ['loadCharacter', 'selectCharacterById', 'clickCharacter'];
        for (const f of funcs) {
            if (typeof window[f] === 'function') {
                console.log(`[角色速切] 调用 window.${f}`);
                window[f](idx);
                return;
            }
        }

        // -----------------------------------------------------------
        // 方案 2: DOM 欺骗 (最强力)
        // -----------------------------------------------------------
        console.log('[角色速切] 使用 DOM 欺骗');
        
        // 1. 找到角色列表容器
        const container = document.getElementById('rm_print_characters_block');
        if (!container) {
            console.error('[角色速切] 找不到角色列表容器');
            return;
        }

        // 2. 创建一个假的点击事件
        // 我们需要找到酒馆绑定点击事件的那个元素
        // 通常是 .character_select 类
        
        // 尝试找到任意一个现存的角色卡
        let anyCard = document.querySelector('.character_select');
        
        // 如果找不到任何卡片（列表为空），我们无法克隆事件
        // 只能尝试手动触发
        
        if (anyCard) {
            // 3. 克隆这个卡片，修改 ID，然后点击它
            // 为什么要克隆？因为现存的卡片上绑定了 jQuery 的事件处理程序！
            // 我们不能直接 new 一个 div，那样没有事件绑定。
            // 但是！clone(true) 可以复制事件处理程序！
            
            // 使用 jQuery 克隆，带上事件和数据
            const $fakeCard = $(anyCard).clone(true, true);
            
            // 修改 ID 为目标角色的 ID
            $fakeCard.attr('chid', idx);
            $fakeCard.attr('data-chid', idx);
            $fakeCard.data('chid', idx); // 修改 jQuery 数据
            
            // 把它插入到容器里 (必须插入，否则事件可能不冒泡)
            // 把它隐藏起来，不要让用户看到闪烁
            $fakeCard.css({ position: 'absolute', top: '-9999px', visibility: 'hidden' });
            $(container).append($fakeCard);
            
            console.log('[角色速切] 触发伪造卡片点击');
            $fakeCard.trigger('click');
            
            // 点完后删掉
            setTimeout(() => $fakeCard.remove(), 500);
            return;
        }

        // -----------------------------------------------------------
        // 方案 3: 如果连一个卡片都没有... (极少见)
        // -----------------------------------------------------------
        // 尝试直接修改 URL 参数并刷新 (最后的无奈之举)
        /*
        const url = new URL(window.location);
        url.searchParams.set('character', idx); // 假设参数名是 character
        window.history.pushState({}, '', url);
        location.reload();
        */
       
        alert('无法切换，请确保至少有一个角色卡可见');

    } catch (e) {
        console.error('[角色速切] 失败:', e);
        alert('失败: ' + e);
    }
}

async function toggleFavorite(char) {
    try {
        const newFav = !(char.fav === true || char.fav === 'true');
        const res = await fetch('/api/characters/merge-attributes', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ avatar: char.avatar, data: { fav: newFav } })
        });
        if (res.ok) {
            char.fav = newFav;
            renderDetailPanel(char);
            fetchAllCharacters();
        }
    } catch (e) {
        console.error('[角色速切] 收藏失败:', e);
    }
}

// ============ 第三个界面：世界书 ============

async function renderWorldBookPanel(char) {
    const panel = document.getElementById('qc-worldbook-panel');
    if (!panel) return;
    
    currentView = 'worldbook';
    showPanel('qc-worldbook-panel');
    
    // 【关键修复】确保侧边栏列表不为空
    const sideList = currentSortedCharacters.length > 0 ? currentSortedCharacters : allCharacters;
    
    panel.innerHTML = `
        <div class="qc-sidebar">
            <button class="qc-back-btn" id="qc-wb-back">返回</button>
            <div class="qc-sidebar-list">
                ${sideList.map(c => `
                    <div class="qc-sidebar-item ${c.avatar === char.avatar ? 'active' : ''}" data-avatar="${c.avatar}">
                        <img src="/characters/${encodeURIComponent(c.avatar)}" onerror="this.src='/img/ai4.png'">
                    </div>
                `).join('')}
            </div>
        </div>
        
        <div class="qc-main">
            <div class="qc-wb-header">
                <h2>📖 ${char.name} 的世界书</h2>
            </div>
            <div class="qc-wb-toolbar">
                <input type="text" class="qc-search" id="qc-wb-search" placeholder="搜索条目...">
            </div>
            <div class="qc-wb-body" id="qc-wb-body">
                <div class="qc-loading"><div class="qc-spinner"></div></div>
            </div>
        </div>
    `;
    
    document.getElementById('qc-wb-back').onclick = () => {
        showPanel('qc-detail-panel');
        currentView = 'detail';
        if (currentDetailChar) renderDetailPanel(currentDetailChar);
    };
    
    document.querySelectorAll('#qc-worldbook-panel .qc-sidebar-item').forEach(item => {
        item.onclick = () => {
            const c = allCharacters.find(x => x.avatar === item.dataset.avatar);
            if (c) { currentDetailChar = c; renderWorldBookPanel(c); }
        };
    });
    
    document.getElementById('qc-wb-search').oninput = (e) => {
        const search = e.target.value.toLowerCase();
        document.querySelectorAll('.qc-wb-entry').forEach(entry => {
            const text = entry.textContent.toLowerCase();
            entry.style.display = text.includes(search) ? '' : 'none';
        });
    };
    
    await loadWorldBookEntries(char);
}

async function loadWorldBookEntries(char) {
    const body = document.getElementById('qc-wb-body');
    if (!body) return;
    
    const charBook = char.data?.character_book;
    if (!charBook || !charBook.entries || Object.keys(charBook.entries).length === 0) {
        body.innerHTML = '<div class="qc-empty">该角色没有内置世界书</div>';
        return;
    }
    
    const entries = Object.values(charBook.entries);
    const entryKeys = Object.keys(charBook.entries);
    
    body.innerHTML = entries.map((entry, idx) => {
        const entryName = entry.comment || entry.name || (Array.isArray(entry.key) ? entry.key[0] : entry.key) || `条目${idx + 1}`;
        const keys = Array.isArray(entry.key) ? entry.key.join(', ') : (entry.key || '无关键词');
        const content = entry.content || '';
        const isEnabled = entry.enabled !== false && entry.disable !== true;
        const isConstant = entry.constant === true;
        
        // 酒馆原生插入位置逻辑
        // 0: Character Defs (Top) - 角色定义之前
        // 1: Character Defs (Bottom) - 角色定义之后 (默认)
        // 2: Author's Note (Top) - 作者注之前
        // 3: Author's Note (Bottom) - 作者注之后
        // 4: At Depth - 指定深度
        const position = entry.position !== undefined ? entry.position : 1; 
        const posMap = {
            0: '角色定义前',
            1: '角色定义后',
            2: '作者注前',
            3: '作者注后',
            4: '指定深度'
        };
        const posText = posMap[position] || '默认';
        
        let statusClass = 'disabled', statusTitle = '禁用';
        if (isConstant) { statusClass = 'constant'; statusTitle = '常驻'; }
        else if (isEnabled) { statusClass = 'enabled'; statusTitle = '启用'; }
        
        return `
            <div class="qc-wb-entry" data-idx="${idx}" data-key="${entryKeys[idx]}">
                <div class="qc-wb-entry-header">
                    <div class="qc-wb-status ${statusClass}" title="${statusTitle}"></div>
                    <div class="qc-wb-key">${entryName}</div>
                    <div class="qc-wb-actions">
                        <button class="qc-wb-toggle" data-action="toggle">${isEnabled ? '🟢' : '⚫'}</button>
                        <button class="qc-wb-toggle" data-action="constant">${isConstant ? '🔵' : '⚪'}</button>
                        <button class="qc-wb-toggle" data-action="expand">📝</button>
                    </div>
                </div>
                <div class="qc-wb-preview">
                    <div class="qc-wb-meta-row">
                        <div class="qc-wb-keywords">🔑 ${keys}</div>
                        <div class="qc-wb-badge">位置: ${posText}</div>
                    </div>
                    <div class="qc-wb-content">${content}</div>
                </div>
                <div class="qc-wb-editor" style="display:none;">
                    <div class="qc-field"><label>名称</label><input type="text" class="qc-input" data-field="name" value="${entryName}"></div>
                    <div class="qc-field"><label>关键词 (逗号分隔)</label><input type="text" class="qc-input" data-field="keys" value="${keys}"></div>
                    
                    <div class="qc-field-row" style="display:flex; gap:10px;">
                        <div class="qc-field" style="flex:1;">
                            <label>插入位置</label>
                            <select class="qc-select" data-field="position" style="width:100%">
                                <option value="0" ${position == 0 ? 'selected' : ''}>角色定义之前 (Top)</option>
                                <option value="1" ${position == 1 ? 'selected' : ''}>角色定义之后 (Bottom)</option>
                                <option value="2" ${position == 2 ? 'selected' : ''}>作者注之前</option>
                                <option value="3" ${position == 3 ? 'selected' : ''}>作者注之后</option>
                                <option value="4" ${position == 4 ? 'selected' : ''}>指定深度 (@Depth)</option>
                            </select>
                        </div>
                        <div class="qc-field" style="width:60px;">
                            <label>优先级</label>
                            <input type="number" class="qc-input" data-field="order" value="${entry.order ?? 0}">
                        </div>
                        <div class="qc-field" style="width:60px;">
                            <label>深度</label>
                            <input type="number" class="qc-input" data-field="depth" value="${entry.depth ?? 4}">
                        </div>
                    </div>

                    <div class="qc-field"><label>内容</label><textarea class="qc-textarea" data-field="content" rows="8">${content}</textarea></div>
                    <div class="qc-field-btns">
                        <button class="qc-btn qc-btn-primary" data-action="save">💾 直接保存</button>
                        <button class="qc-btn" data-action="cancel">取消</button>
                    </div>
                </div>
            </div>
        `;
    }).join('');
    
    bindWorldBookEvents(char, entries, entryKeys);
}

function bindWorldBookEvents(char, entries, entryKeys) {
    
    // 强制全量保存函数
    const forceSave = async () => {
        return new Promise((resolve, reject) => {
            // 1. 确保 char 对象是最新的
            const context = getContext();
            const liveChar = context.characters.find(c => c.avatar === char.avatar);
            if (liveChar) {
                // 将我们的修改同步到实时对象
                liveChar.data.character_book = char.data.character_book;
            }

            // 2. 构造完整的 FormData
            const formData = new FormData();
            formData.append('avatar_url', char.avatar);
            formData.append('ch_name', char.name);
            
            // 关键：把整个 character_book 对象序列化发过去
            formData.append('world', JSON.stringify(char.data.character_book));
            
            // 其他必填字段，防止被清空
            const fields = ['description', 'first_mes', 'personality', 'scenario', 'mes_example', 'creator_notes', 'system_prompt', 'post_history_instructions', 'creator', 'character_version', 'tags'];
            fields.forEach(f => {
                let val = char[f] || char.data?.[f];
                if (typeof val === 'object') val = JSON.stringify(val);
                formData.append(f, val || '');
            });

            // 3. 发送请求
            $.ajax({
                url: '/api/characters/edit',
                type: 'POST',
                data: formData,
                processData: false,
                contentType: false,
                success: (data) => {
                    console.log('[角色速切] 保存成功', data);
                    // 强制刷新酒馆内部状态
                    if (typeof window.reloadCurrentCharacter === 'function') {
                        window.reloadCurrentCharacter();
                    }
                    resolve(data);
                },
                error: (xhr) => {
                    console.error('[角色速切] 保存失败', xhr);
                    reject(xhr.responseText);
                }
            });
        });
    };

    document.querySelectorAll('.qc-wb-entry').forEach((el) => {
        const idx = parseInt(el.dataset.idx);
        const key = el.dataset.key;
        // 获取引用，直接修改原始对象
        const entry = char.data.character_book.entries[key];
        
        const toggleBtn = el.querySelector('[data-action="toggle"]');
        const constantBtn = el.querySelector('[data-action="constant"]');
        const expandBtn = el.querySelector('[data-action="expand"]');
        const editor = el.querySelector('.qc-wb-editor');
        const preview = el.querySelector('.qc-wb-preview');
        const statusDiv = el.querySelector('.qc-wb-status');
        
        const updateUI = () => {
            const isEnabled = entry.enabled !== false && entry.disable !== true;
            statusDiv.className = `qc-wb-status ${entry.constant ? 'constant' : isEnabled ? 'enabled' : 'disabled'}`;
            toggleBtn.textContent = isEnabled ? '🟢' : '⚫';
            constantBtn.textContent = entry.constant ? '🔵' : '⚪';
        };
        
        // 切换开关
        toggleBtn.onclick = async () => {
            const isEnabled = entry.enabled !== false && entry.disable !== true;
            // 必须同时设置 enabled 和 disable 两个字段，兼容旧版酒馆
            entry.enabled = !isEnabled;
            entry.disable = isEnabled; // 注意这里是反的
            
            updateUI();
            try {
                await forceSave();
            } catch (e) {
                alert('保存失败: ' + e);
            }
        };
        
        // 切换常驻
        constantBtn.onclick = async () => {
            entry.constant = !entry.constant;
            updateUI();
            try {
                await forceSave();
            } catch (e) {
                alert('保存失败: ' + e);
            }
        };
        
        // 展开编辑
        expandBtn.onclick = () => {
            const show = editor.style.display === 'none';
            editor.style.display = show ? 'block' : 'none';
            preview.style.display = show ? 'none' : 'block';
        };
        
        el.querySelector('[data-action="cancel"]').onclick = () => {
            editor.style.display = 'none';
            preview.style.display = 'block';
        };
        
        // 保存编辑内容
        el.querySelector('[data-action="save"]').onclick = async () => {
            // 获取值
            entry.comment = el.querySelector('[data-field="name"]').value;
            entry.name = entry.comment;
            entry.key = el.querySelector('[data-field="keys"]').value.split(',').map(k => k.trim()).filter(k => k);
            entry.content = el.querySelector('[data-field="content"]').value;
            entry.position = parseInt(el.querySelector('[data-field="position"]').value);
            entry.order = parseInt(el.querySelector('[data-field="order"]').value) || 0;
            entry.depth = parseInt(el.querySelector('[data-field="depth"]').value) || 4;
            
            // 更新预览
            el.querySelector('.qc-wb-key').textContent = entry.name;
            el.querySelector('.qc-wb-keywords').textContent = '🔑 ' + entry.key.join(', ');
            el.querySelector('.qc-wb-content').textContent = entry.content;
            const posMap = { 0: '角色定义前', 1: '角色定义后', 2: '作者注前', 3: '作者注后', 4: '指定深度' };
            el.querySelector('.qc-wb-badge').textContent = '位置: ' + (posMap[entry.position] || '默认');
            
            editor.style.display = 'none';
            preview.style.display = 'block';
            
            try {
                await forceSave();
                alert('保存成功！');
            } catch (e) {
                alert('保存失败: ' + e);
            }
        };
    });
}

// ============ 第四个界面：排行榜 ============

async function renderRankingPanel() {
    const panel = document.getElementById('qc-ranking-panel');
    if (!panel) return;
    
    currentView = 'ranking';
    showPanel('qc-ranking-panel');
    
    // 【关键修复】确保侧边栏列表不为空
    const sideList = currentSortedCharacters.length > 0 ? currentSortedCharacters : allCharacters;
    
    panel.innerHTML = `
        <div class="qc-sidebar">
            <button class="qc-back-btn" id="qc-rank-back">返回</button>
            <div class="qc-sidebar-list">
                ${sideList.map(c => `
                    <div class="qc-sidebar-item" data-avatar="${c.avatar}">
                        <img src="/characters/${encodeURIComponent(c.avatar)}" onerror="this.src='/img/ai4.png'">
                    </div>
                `).join('')}
            </div>
        </div>
        
        <div class="qc-main">
            <div class="qc-rank-header">
                <h2>🏆 排行榜</h2>
            </div>
            <div class="qc-rank-body" id="qc-rank-body">
                <div class="qc-loading"><div class="qc-spinner"></div></div>
            </div>
        </div>
    `;
    
    document.getElementById('qc-rank-back').onclick = () => {
        showPanel('qc-panel');
        currentView = 'main';
    };
    
    document.querySelectorAll('#qc-ranking-panel .qc-sidebar-item').forEach(item => {
        item.onclick = () => {
            const c = allCharacters.find(x => x.avatar === item.dataset.avatar);
            if (c) { renderDetailPanel(c); }
        };
    });
    
    await loadRankingData();
}

async function loadRankingData() {
    const body = document.getElementById('qc-rank-body');
    if (isAnalyzing) {
        if (body && !document.getElementById('qc-rank-progress')) {
             body.innerHTML = `<div style="padding:20px;text-align:center;color:#888;">后台分析中...</div>`;
        }
        return;
    }
    
    if (body) body.innerHTML = `<div style="padding:20px;text-align:center;color:#888;"><div class="qc-spinner" style="margin:0 auto 10px;"></div><div id="qc-rank-progress">准备分析...</div></div>`;
    
    isAnalyzing = true;
    try {
        const uncached = allCharacters.filter(c => !characterChatsCache[c.avatar]);
        const total = uncached.length;
        let loaded = 0;
        
        if (total > 0) {
            const batchSize = 5;
            for (let i = 0; i < total; i += batchSize) {
                const batch = uncached.slice(i, i + batchSize);
                await Promise.all(batch.map(char => fetchCharacterChats(char.avatar)));
                loaded += batch.length;
                
                const prog = document.getElementById('qc-rank-progress');
                if (prog) prog.textContent = `正在分析: ${loaded} / ${total}`;
                
                if (loaded % 20 === 0 || loaded === total) {
                    if (currentView === 'ranking') updateRankingUI(loaded === total);
                }
                await new Promise(r => setTimeout(r, 50));
            }
        } else {
            if (currentView === 'ranking') updateRankingUI(true);
        }
    } catch (e) {
        if (body) body.innerHTML = `<div class="qc-empty">分析出错</div>`;
    } finally {
        isAnalyzing = false;
    }
}

async function updateRankingUI(isFinal) {
    const body = document.getElementById('qc-rank-body');
    if (!body || currentView !== 'ranking') return;
    
    const [randomChar, topDays, topWeek, topMonth, topYear, topMsgs] = await Promise.all([
        Promise.resolve(getRandomCharacter()),
        getTopInteractionDaysCharacters(5),
        getTopFavoriteCharacters('week', 5),
        getTopFavoriteCharacters('month', 5),
        getTopFavoriteCharacters('year', 5),
        getTopMessageCountCharacters(5)
    ]);
    
    body.innerHTML = `
        <div class="qc-rank-section">
            <h3>🎲 随机角色</h3>
            <div class="qc-rank-random" id="qc-random">
                ${randomChar ? `
                    <div class="qc-rank-card" data-avatar="${randomChar.avatar}">
                        <img src="/characters/${encodeURIComponent(randomChar.avatar)}" onerror="this.src='/img/ai4.png'">
                        <span>${randomChar.name}</span>
                    </div>
                ` : '<div class="qc-empty">无角色</div>'}
                <button class="qc-btn" id="qc-reroll">🔄</button>
            </div>
        </div>
        <div class="qc-rank-section"><h3>📅 互动天数</h3>${renderRankList(topDays, 'days', '天')}</div>
        <div class="qc-rank-section"><h3>💕 本周最爱</h3>${renderRankList(topWeek, 'messages', '条')}</div>
        <div class="qc-rank-section"><h3>💖 本月最爱</h3>${renderRankList(topMonth, 'messages', '条')}</div>
        <div class="qc-rank-section"><h3>❤️ 本年最爱</h3>${renderRankList(topYear, 'messages', '条')}</div>
        <div class="qc-rank-section"><h3>💬 总楼层</h3>${renderRankList(topMsgs, 'total', '条')}</div>
    `;
    
    document.getElementById('qc-reroll').onclick = () => {
        updateRankingUI(true);
    };
    
    bindRankCardEvents();
}

function renderRankList(items, key, unit) {
    if (!items || items.length === 0) return '<div class="qc-empty">暂无数据</div>';
    return `<div class="qc-rank-list">${items.map((item, i) => `
        <div class="qc-rank-item" data-avatar="${item.character.avatar}">
            <span class="qc-rank-num">${i + 1}</span>
            <img src="/characters/${encodeURIComponent(item.character.avatar)}" onerror="this.src='/img/ai4.png'">
            <span class="qc-rank-name">${item.character.name}</span>
            <span class="qc-rank-val">${item[key]}${unit}</span>
        </div>
    `).join('')}</div>`;
}

function bindRankCardEvents() {
    document.querySelectorAll('.qc-rank-item, .qc-rank-card').forEach(el => {
        el.onclick = () => {
            const c = allCharacters.find(x => x.avatar === el.dataset.avatar);
            if (c) renderDetailPanel(c);
        };
    });
}

function bindToolbarEvents() {
    document.getElementById('qc-sort-method').onchange = (e) => { pluginSettings.sortMethod = e.target.value; renderCharacterGrid(1); };
    document.getElementById('qc-sort-order').onclick = (e) => { 
        pluginSettings.sortOrder = pluginSettings.sortOrder === 'desc' ? 'asc' : 'desc';
        e.currentTarget.textContent = pluginSettings.sortOrder === 'desc' ? '↓' : '↑';
        renderCharacterGrid(1); 
    };
    document.getElementById('qc-grid-columns').onchange = (e) => { 
        let val = parseInt(e.target.value); 
        if(val<3) val=3; if(val>10) val=10; 
        pluginSettings.gridColumns = val; renderCharacterGrid(currentPage); 
    };
    document.getElementById('qc-search').oninput = debounce(() => renderCharacterGrid(1), 300);
    document.getElementById('qc-tag-filter').onchange = (e) => { pluginSettings.filterTag = e.target.value; renderCharacterGrid(1); };
    document.getElementById('qc-fav-btn').onclick = (e) => {
        const btn = e.currentTarget;
        if (pluginSettings.filterFav === 'all') { pluginSettings.filterFav = 'fav'; btn.classList.add('active'); }
        else if (pluginSettings.filterFav === 'fav') { pluginSettings.filterFav = 'unfav'; btn.classList.remove('active'); btn.classList.add('dim'); }
        else { pluginSettings.filterFav = 'all'; btn.classList.remove('active', 'dim'); }
        renderCharacterGrid(1);
    };
    document.getElementById('qc-ranking-btn').onclick = () => renderRankingPanel();
    document.getElementById('qc-close-btn').onclick = closePanel;
}

function closePanel() {
    document.getElementById('qc-overlay').style.display = 'none';
    currentView = 'main';
    document.activeElement?.blur();
}

async function openPanel() {
    fetchAllCharacters();
    fetchAllTags();
    
    let overlay = document.getElementById('qc-overlay');
    if (overlay) overlay.remove();
    
    document.body.insertAdjacentHTML('beforeend', createMainPanelHTML());
    bindToolbarEvents();
    document.getElementById('qc-overlay').onclick = (e) => { if (e.target.id === 'qc-overlay') closePanel(); };
    document.getElementById('qc-overlay').style.display = 'flex';
    
    document.getElementById('qc-sort-method').value = pluginSettings.sortMethod;
    document.getElementById('qc-grid-columns').value = pluginSettings.gridColumns;
    
    preloadAllChatsInBackground();
    await renderCharacterGrid(1);
}

function addMenuButton() {
    const wait = setInterval(() => {
        const menu = document.getElementById('extensionsMenu');
        if (menu && !document.getElementById('qc-menu-btn')) {
            const item = document.createElement('div');
            item.id = 'qc-menu-btn';
            item.className = 'list-group-item flex-container flexGap5';
            item.innerHTML = '<span>⚡ 角色速切</span>';
            item.style.cursor = 'pointer';
            item.onclick = openPanel;
            menu.appendChild(item);
            clearInterval(wait);
        }
    }, 500);
    setTimeout(() => clearInterval(wait), 10000);
}

jQuery(() => { console.log('[角色速切] 插件加载中...'); addMenuButton(); });
