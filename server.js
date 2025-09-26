const WebSocket = require('ws');
const http = require('http');
const express = require('express');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Обслуживаем статические файлы
app.use(express.static(path.join(__dirname, '.')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Игровое состояние
const gameState = {
    pixels: {},
    players: {},
    leaderboard: []
};

// Функция для обновления таблицы лидеров
function updateLeaderboard() {
    gameState.leaderboard = Object.values(gameState.players)
        .sort((a, b) => b.tokens - a.tokens)
        .slice(0, 10);
}

// Функция для восстановления энергии игроков
function regenerateEnergy() {
    Object.keys(gameState.players).forEach(playerId => {
        const player = gameState.players[playerId];
        if (player.energy < 100) {
            player.energy = Math.min(100, player.energy + 10);
            // Отправляем обновление энергии игроку
            if (player.ws && player.ws.readyState === WebSocket.OPEN) {
                player.ws.send(JSON.stringify({
                    type: 'playerStats',
                    tokens: player.tokens,
                    level: player.level,
                    energy: player.energy
                }));
            }
        }
    });
}

// Восстановление энергии каждые 30 секунд
setInterval(regenerateEnergy, 30000);

wss.on('connection', (ws) => {
    console.log('Новое подключение');
    
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            handleMessage(ws, data);
        } catch (error) {
            console.error('Ошибка парсинга сообщения:', error);
        }
    });
    
    ws.on('close', () => {
        // Удаляем игрока при отключении
        for (let playerId in gameState.players) {
            if (gameState.players[playerId].ws === ws) {
                delete gameState.players[playerId];
                break;
            }
        }
        broadcastPlayerList();
        updateLeaderboard();
        broadcastLeaderboard();
    });
});

function handleMessage(ws, data) {
    switch (data.type) {
        case 'join':
            gameState.players[data.playerId] = {
                ws: ws,
                playerId: data.playerId,
                username: data.username || 'Гость',
                tokens: data.tokens || 0,
                level: data.level || 1,
                energy: data.energy || 100,
                color: data.color || '#ff4444'
            };
            
            // Отправляем текущее состояние игроку
            ws.send(JSON.stringify({
                type: 'playerStats',
                tokens: gameState.players[data.playerId].tokens,
                level: gameState.players[data.playerId].level,
                energy: gameState.players[data.playerId].energy
            }));
            
            // Отправляем все существующие пиксели
            for (let pixelId in gameState.pixels) {
                const [x, y] = pixelId.split(',').map(Number);
                ws.send(JSON.stringify({
                    type: 'pixelUpdate',
                    pixelId: pixelId,
                    x: x,
                    y: y,
                    color: gameState.pixels[pixelId],
                    playerId: 'server'
                }));
            }
            
            broadcastPlayerList();
            updateLeaderboard();
            broadcastLeaderboard();
            break;
            
        case 'placePixel':
            const player = gameState.players[data.playerId];
            if (player && player.energy > 0) {
                const pixelId = `${data.x},${data.y}`;
                gameState.pixels[pixelId] = data.color;
                
                // Награждаем игрока
                player.tokens += 0.1;
                player.energy -= 1;
                
                // Проверяем повышение уровня
                const newLevel = Math.floor(player.tokens / 100) + 1;
                if (newLevel > player.level) {
                    player.level = newLevel;
                }
                
                // Отправляем обновление статистики
                ws.send(JSON.stringify({
                    type: 'playerStats',
                    tokens: player.tokens,
                    level: player.level,
                    energy: player.energy
                }));
                
                // Рассылаем обновление пикселя всем игрокам
                broadcast({
                    type: 'pixelUpdate',
                    pixelId: pixelId,
                    x: data.x,
                    y: data.y,
                    color: data.color,
                    playerId: data.playerId,
                    playerName: data.username
                });
                
                updateLeaderboard();
                broadcastLeaderboard();
            }
            break;
            
        case 'useDynamite':
            const dynamitePlayer = gameState.players[data.playerId];
            if (dynamitePlayer && dynamitePlayer.tokens >= 100) {
                dynamitePlayer.tokens -= 100;
                
                // Очищаем все пиксели
                gameState.pixels = {};
                
                // Рассылаем сообщение о сбросе
                broadcast({
                    type: 'pixelsReset',
                    playerId: data.playerId,
                    playerName: data.username,
                    color: '#000000'
                });
                
                // Отправляем обновление статистики
                ws.send(JSON.stringify({
                    type: 'playerStats',
                    tokens: dynamitePlayer.tokens,
                    level: dynamitePlayer.level,
                    energy: dynamitePlayer.energy
                }));
                
                updateLeaderboard();
                broadcastLeaderboard();
            }
            break;
            
        case 'playerColorUpdate':
            if (gameState.players[data.playerId]) {
                gameState.players[data.playerId].color = data.color;
                broadcast({
                    type: 'playerColorUpdate',
                    playerId: data.playerId,
                    color: data.color
                });
            }
            break;
    }
}

function broadcast(message) {
    const messageStr = JSON.stringify(message);
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(messageStr);
        }
    });
}

function broadcastPlayerList() {
    const players = {};
    for (let playerId in gameState.players) {
        players[playerId] = {
            username: gameState.players[playerId].username,
            tokens: gameState.players[playerId].tokens,
            level: gameState.players[playerId].level
        };
    }
    
    broadcast({
        type: 'playerList',
        players: players
    });
}

function broadcastLeaderboard() {
    broadcast({
        type: 'leaderboard',
        leaderboard: gameState.leaderboard
    });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Сервер запущен на порту ${PORT}`);
    console.log(`Откройте http://localhost:${PORT} в браузере`);
});
