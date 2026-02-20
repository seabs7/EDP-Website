import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import multer from 'multer';

const app = express();
const upload = multer({ storage: multer.memoryStorage() });
app.use(express.json());

const APS_BASE = 'https://developer.api.autodesk.com';

const {
  APS_CLIENT_ID,
  APS_CLIENT_SECRET,
  APS_BUCKET_KEY,
  APS_REGION = 'US',
  APS_ALLOWED_ORIGINS = '',
  PORT = 8787
} = process.env;

const allowedOrigins = APS_ALLOWED_ORIGINS
  .split(',')
  .map(origin => origin.trim())
  .filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.length === 0) {
      return callback(null, true);
    }
    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error('CORS not allowed'));
  }
}));

function requireEnv() {
  const missing = [];
  if (!APS_CLIENT_ID) missing.push('APS_CLIENT_ID');
  if (!APS_CLIENT_SECRET) missing.push('APS_CLIENT_SECRET');
  if (!APS_BUCKET_KEY) missing.push('APS_BUCKET_KEY');
  if (missing.length > 0) {
    const message = `Missing env vars: ${missing.join(', ')}`;
    const error = new Error(message);
    error.status = 500;
    throw error;
  }
}

async function getAccessToken() {
  requireEnv();
  const params = new URLSearchParams({
    client_id: APS_CLIENT_ID,
    client_secret: APS_CLIENT_SECRET,
    grant_type: 'client_credentials',
    scope: 'data:read data:write data:create bucket:create bucket:read'
  });

  const res = await fetch(`${APS_BASE}/authentication/v2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params
  });

  if (!res.ok) {
    const text = await res.text();
    const error = new Error(`Token request failed: ${res.status} ${text}`);
    error.status = res.status;
    throw error;
  }

  return res.json();
}

async function ensureBucket(token) {
  const bucketKey = APS_BUCKET_KEY.toLowerCase();
  const details = await fetch(`${APS_BASE}/oss/v2/buckets/${bucketKey}/details`, {
    headers: { Authorization: `Bearer ${token}` }
  });

  if (details.ok) {
    return;
  }

  if (details.status !== 404) {
    const text = await details.text();
    throw new Error(`Bucket check failed: ${details.status} ${text}`);
  }

  const res = await fetch(`${APS_BASE}/oss/v2/buckets`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'x-ads-region': APS_REGION
    },
    body: JSON.stringify({
      bucketKey,
      policyKey: 'persistent'
    })
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Bucket create failed: ${res.status} ${text}`);
  }
}

async function uploadToBucket(token, file) {
  const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
  const objectName = `${Date.now()}-${safeName}`;

  const res = await fetch(
    `${APS_BASE}/oss/v2/buckets/${APS_BUCKET_KEY.toLowerCase()}/objects/${encodeURIComponent(objectName)}`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/octet-stream'
      },
      body: file.buffer
    }
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Upload failed: ${res.status} ${text}`);
  }

  const data = await res.json();
  return data.objectId;
}

async function startTranslation(token, urn) {
  const res = await fetch(`${APS_BASE}/modelderivative/v2/designdata/job`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      input: { urn },
      output: {
        formats: [{
          type: 'svf2',
          views: ['2d', '3d']
        }]
      }
    })
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Translate failed: ${res.status} ${text}`);
  }
}

app.get('/api/aps/token', async (req, res, next) => {
  try {
    const token = await getAccessToken();
    res.json(token);
  } catch (err) {
    next(err);
  }
});

app.post('/api/aps/upload-translate', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded.' });
    }

    const tokenData = await getAccessToken();
    await ensureBucket(tokenData.access_token);
    const objectId = await uploadToBucket(tokenData.access_token, req.file);
    const urn = Buffer.from(objectId).toString('base64');
    await startTranslation(tokenData.access_token, urn);

    res.json({ urn });
  } catch (err) {
    next(err);
  }
});

app.get('/api/aps/manifest/:urn', async (req, res, next) => {
  try {
    const tokenData = await getAccessToken();
    const urn = req.params.urn;
    const result = await fetch(`${APS_BASE}/modelderivative/v2/designdata/${encodeURIComponent(urn)}/manifest`, {
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });

    const data = await result.json();
    res.status(result.status).json(data);
  } catch (err) {
    next(err);
  }
});

app.use((err, req, res, next) => {
  const status = err.status || 500;
  res.status(status).json({ error: err.message || 'Server error' });
});

app.listen(PORT, () => {
  console.log(`APS server running on http://localhost:${PORT}`);
});
