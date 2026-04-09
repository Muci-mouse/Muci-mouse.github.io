const http = require('http');
const crypto = require('crypto');
const { WebSocket } = require('ws');

const PORT = 3000;
const TTS_WS_URL = 'wss://openspeech.bytedance.com/api/v1/tts/ws_binary';
const TTS_APP_ID = '6213247751';
const TTS_ACCESS_TOKEN = 'gNth552LHn3utfqigKyllMA512JZ8eU6';
const TTS_VOICE_TYPE = 'zh_female_vv_uranus_bigtts';

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  response.end(JSON.stringify(body));
}

function synthesizeSpeech(text) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(TTS_WS_URL, {
      headers: {
        Authorization: `Bearer; ${TTS_ACCESS_TOKEN}`,
      },
    });

    const audioChunks = [];
    let settled = false;

    const cleanup = () => {
      try {
        ws.close();
      } catch (error) {
        // ignore
      }
    };

    const finish = (callback) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      callback();
    };

    ws.on('open', () => {
      ws.send(JSON.stringify({
        header: {
          appid: TTS_APP_ID,
          token: TTS_ACCESS_TOKEN,
          reqid: crypto.randomUUID(),
        },
        payload: {
          audio: {
            voice_type: TTS_VOICE_TYPE,
            encoding: 'mp3',
            speed_ratio: 1,
            volume_ratio: 1,
            pitch_ratio: 1.08,
          },
          request: {
            reqid: crypto.randomUUID(),
            text,
            text_type: 'plain',
            operation: 'submit',
          },
          user: {
            uid: 'moy-user',
          },
        },
      }));
    });

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        audioChunks.push(Buffer.from(data));
        return;
      }

      const rawText = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
      let message;
      try {
        message = JSON.parse(rawText);
      } catch (error) {
        return;
      }

      const audioBase64 = message?.payload?.audio || message?.data?.audio || message?.audio;
      if (typeof audioBase64 === 'string' && audioBase64) {
        audioChunks.push(Buffer.from(audioBase64, 'base64'));
      }

      const code = message?.code ?? message?.header?.code;
      if (code && code !== 0 && code !== 200) {
        finish(() => reject(new Error(`TTS error ${code}`)));
        return;
      }

      const isFinal = message?.payload?.is_final || message?.is_final || message?.header?.is_final || message?.event === 'finish';
      if (isFinal) {
        const audioBuffer = Buffer.concat(audioChunks);
        if (!audioBuffer.length) {
          finish(() => reject(new Error('TTS returned empty audio')));
          return;
        }
        finish(() => resolve(audioBuffer));
      }
    });

    ws.on('error', (error) => {
      finish(() => reject(error));
    });

    ws.on('close', () => {
      if (settled) {
        return;
      }
      const audioBuffer = Buffer.concat(audioChunks);
      if (audioBuffer.length) {
        finish(() => resolve(audioBuffer));
        return;
      }
      finish(() => reject(new Error('TTS connection closed before audio was returned')));
    });
  });
}

const server = http.createServer(async (request, response) => {
  if (request.method === 'OPTIONS') {
    response.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    response.end();
    return;
  }

  if (request.method === 'POST' && request.url === '/tts') {
    const chunks = [];
    request.on('data', (chunk) => {
      chunks.push(chunk);
    });

    request.on('end', async () => {
      try {
        const bodyText = Buffer.concat(chunks).toString('utf8');
        const body = bodyText ? JSON.parse(bodyText) : {};
        const text = String(body.text || '').trim();

        if (!text) {
          sendJson(response, 400, { error: 'text is required' });
          return;
        }

        const audioBuffer = await synthesizeSpeech(text);
        response.writeHead(200, {
          'Content-Type': 'audio/mpeg',
          'Content-Length': audioBuffer.length,
          'Access-Control-Allow-Origin': '*',
        });
        response.end(audioBuffer);
      } catch (error) {
        sendJson(response, 500, { error: error.message || 'tts failed' });
      }
    });
    return;
  }

  sendJson(response, 404, { error: 'not found' });
});

server.listen(PORT, () => {
  console.log(`Moy TTS proxy running at http://localhost:${PORT}`);
});
