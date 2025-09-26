const WebSocket = require('ws');
const http = require('http');
const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, '.')));
app.use(express.json());

// Загрузка и сохранение пикселей
function loadPixels() {
    try {
        if (fs.existsSync('pixels.json')) {
            return JSON.parse(fs.readFileSync('pixels.json', 'utf8'));
        }
    } catch (error) {
        console.error('Error loading pixels:', error);
    }
    return {};
}

function savePixels(pixels) {
    try {
        fs.writeFileSync('pixels.json', JSON.stringify(pixels, null, 2));
    } catch (error) {
        console.error('Error saving pixels:', error);
    }
}

const gameState = {
    pixels: loadPixels(),
    players: {},
    leaderboard: []
};

function updateLeaderboard() {
    gameState.leaderboard = Object.values(gameState.players)
        .sort((a, b) => b.tokens - a.tokens)
        .slice(0, 100);
}

function broadcastLeaderboard() {
    const message = JSON.stringify({
        type: 'leaderboardUpdate',
        leaderboard: gameState.leaderboard.slice(0, 100),
        topThree: gameState.leaderboard.slice(0, 3)
    });
    
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });
}

wss.on('connection', (ws) => {
    console.log('Новый игрок подключился');
    
    // Отправляем текущее состояние
    ws.send(JSON.stringify({
        type: 'initialData',
        pixels: gameState.pixels,
        leaderboard: gameState.leaderboard,
        topThree: gameState.leaderboard.slice(0, 3)
    }));
    
    ws.on('message', (data) => {
        try {
            const message = JSON.parse(data);
            handleMessage(ws, message);
        } catch (error) {
            console.error('Ошибка парсинга сообщения:', error);
        }
    });
    
    ws.on('close', () => {
        // Удаляем игрока
        for (let playerId in gameState.players) {
            if (gameState.players[playerId].ws === ws) {
                console.log(`Игрок ${gameState.players[playerId].username} отключился`);
                delete gameState.players[playerId];
                break;
            }
        }
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
                username: data.username,
                tokens: data.tokens || 0,
                level: data.level || 1,
                energy: data.energy || 100,
                color: data.color || '#ff4444',
                joinTime: Date.now()
            };
            
            updateLeaderboard();
            broadcastLeaderboard();
            break;
            
        case 'placePixel':
            const player = gameState.players[data.playerId];
            if (player && player.energy > 0) {
                const pixelId = `${data.x},${data.y}`;
                gameState.pixels[pixelId] = data.color;
                
                // Обновляем статистику игрока
                player.tokens += 0.1;
                player.energy -= 1;
                player.level = Math.floor(player.tokens / 100) + 1;
                
                // Сохраняем пиксели
                savePixels(gameState.pixels);
                
                // Рассылаем обновление
                const message = JSON.stringify({
                    type: 'pixelPlaced',
                    pixelId: pixelId,
                    x: data.x,
                    y: data.y,
                    color: data.color,
                    playerId: data.playerId,
                    playerName: data.username,
                    tokens: player.tokens,
                    energy: player.energy,
                    level: player.level
                });
                
                wss.clients.forEach(client => {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(message);
                    }
                });
                
                updateLeaderboard();
                broadcastLeaderboard();
            }
            break;
            
        case 'updateColor':
            if (gameState.players[data.playerId]) {
                gameState.players[data.playerId].color = data.color;
            }
            break;
    }
}

// Автосохранение каждые 30 секунд
setInterval(() => {
    savePixels(gameState.pixels);
    console.log('Пиксели автосохранены');
}, 30000);

// Восстановление энергии каждые 30 секунд
setInterval(() => {
    Object.values(gameState.players).forEach(player => {
        if (player.energy < 100) {
            player.energy = Math.min(100, player.energy + 10);
            
            // Отправляем обновление энергии
            if (player.ws.readyState === WebSocket.OPEN) {
                player.ws.send(JSON.stringify({
                    type: 'energyUpdate',
                    energy: player.energy
                }));
            }
        }
    });
}, 30000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🎮 Pixel Battle Server запущен!`);
    console.log(`📍 Порт: ${PORT}`);
    console.log(`🌐 Откройте: http://localhost:${PORT}`);
});
