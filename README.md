# HASHD IPFS Relayer

**Optional convenience service** for uploading encrypted content to IPFS. The HASHD frontend works entirely without this relayer - users can always upload directly to any IPFS provider.

## What This Does

This relayer provides a **convenience layer** that:
- Handles IPFS uploads automatically for a smoother user experience
- Verifies group membership to prevent spam
- Provides rate limiting for abuse prevention

## What This Doesn't Do

- **Not required**: The frontend works without this service
- **Not centralized**: Users can bypass this entirely
- **Not a dependency**: Manual IPFS upload is always available

## Alternative: Direct IPFS Upload

Users can skip this relayer and upload directly:

1. **Encrypt content** locally in browser
2. **Upload to any IPFS service** (Pinata, Filebase, Web3.Storage, etc.)
3. **Submit the CID** directly to the smart contract

The frontend includes a "Manual Upload" option for this workflow.

## Setup

### 1. Install Dependencies

```bash
cd relayer
npm install
```

### 2. Configure Environment

Copy `.env.example` to `.env` and update:

```bash
cp .env.example .env
```

Edit `.env`:

```env
# Server
PORT=3001
CORS_ORIGIN=http://localhost:3000

# MegaETH
MEGAETH_RPC_URL=https://carrot.megaeth.com/rpc
CHAIN_ID=6342

# Filebase S3
FILEBASE_ACCESS_KEY=
FILEBASE_SECRET_KEY=
FILEBASE_BUCKET=
FILEBASE_ENDPOINT=

# Contracts
USER_PROFILE_ADDRESS=
GROUP_FACTORY_ADDRESS=

# Rate Limiting
MAX_UPLOADS_PER_HOUR=10
MAX_FILE_SIZE_MB=10
```

### 3. Get Filebase API Keys

1. Go to [Filebase Console](https://console.filebase.com)
2. Sign up for a free account (5GB free storage)
3. Navigate to **Access Keys** in the dashboard
4. Click **Create Access Key**
5. Copy the **Access Key ID** and **Secret Access Key**
6. Add them to `.env` as `FILEBASE_ACCESS_KEY` and `FILEBASE_SECRET_KEY`

### 4. Create Filebase Bucket

1. In Filebase Console, go to **Buckets**
2. Click **Create Bucket**
3. Name it `hashd-posts`
4. Select **IPFS** as the storage network
5. Click **Create**

### 5. Start Server

```bash
npm start
```

Or for development with auto-reload:

```bash
npm run dev
```

## API Endpoints

### POST /api/upload

Upload encrypted content to IPFS.

**Request:**

```typescript
FormData {
  file: Blob,                    // Encrypted content
  userAddress: string,           // User's wallet address
  groupPostsAddress: string,     // GroupPosts contract address
  signature: string,             // Signed message
  timestamp: string,             // Upload timestamp
  nonce: string,                 // Random nonce
  contentHash: string            // keccak256(encrypted content)
}
```

**Signature Message Format:**

```
Upload to {groupPostsAddress}
Hash: {contentHash}
Timestamp: {timestamp}
Nonce: {nonce}
```

**Response:**

```json
{
  "success": true,
  "cid": "QmXXX...",
  "contentHash": "0xabc...",
  "timestamp": "2025-11-03T12:00:00.000Z"
}
```

**Errors:**

- `400` - Missing fields, invalid timestamp, hash mismatch
- `401` - Invalid signature
- `403` - Not a group member
- `429` - Rate limit exceeded
- `500` - Upload failed

### GET /health

Health check endpoint.

**Response:**

```json
{
  "status": "ok",
  "service": "HASHD IPFS Relayer",
  "timestamp": "2025-11-03T12:00:00.000Z"
}
```

### GET /api/stats

Get upload statistics.

**Response:**

```json
{
  "activeUsers": 5,
  "totalUploadsLastHour": 23
}
```

## Security

### Signature Verification

1. Client signs a message with their wallet
2. Server recovers the signer address from signature
3. Verifies it matches the claimed `userAddress`

### Membership Verification

1. Server queries `GroupPosts.groupToken()` to get group token address
2. Queries `UserProfile.isMember(user, groupToken)` on-chain
3. Only allows upload if user is a member

### Rate Limiting

- In-memory store (use Redis for production)
- 10 uploads per hour per user address
- Configurable via `MAX_UPLOADS_PER_HOUR`

### Content Integrity

- Client computes `keccak256(encrypted content)`
- Server verifies hash matches before upload
- Prevents tampering during transit

## Filebase Integration

The relayer uses Filebase's S3-compatible API to upload to IPFS:

```javascript
const s3 = new AWS.S3({
  endpoint: 'https://s3.filebase.com',
  accessKeyId: 'YOUR_KEY',
  secretAccessKey: 'YOUR_SECRET',
  s3ForcePathStyle: true,
  signatureVersion: 'v4'
});
```

Files are automatically pinned to IPFS and the CID is extracted from metadata.

## Production Deployment

### Docker (Recommended)

```bash
# Build and run with Docker Compose
docker-compose up -d

# View logs
docker-compose logs -f

# Stop
docker-compose down
```

### Manual Deployment

```bash
# Install dependencies
npm ci --only=production

# Set production environment
export NODE_ENV=production

# Start with process manager
npm install -g pm2
pm2 start server.js --name hashd-relayer

# Or start directly
npm start
```

### Security Considerations

- **Environment Variables**: Never commit `.env` files with real credentials
- **CORS**: Configure `CORS_ORIGIN` to only allow your frontend domain
- **Rate Limiting**: Adjust `MAX_UPLOADS_PER_HOUR` based on your needs
- **HTTPS**: Use a reverse proxy (nginx, Cloudflare) for SSL termination
- **Monitoring**: Monitor logs for failed uploads and rate limit violations

## Remember: This is Optional

The HASHD protocol is designed to work without any centralized services. This relayer is purely for convenience - users always have the option to upload directly to IPFS themselves.

## Monitoring

Check server logs for:

- Upload success/failure rates
- Rate limit hits
- Signature verification failures
- Membership check failures
- Filebase API errors

## Common Issues

- **Rate limit exceeded**: Wait 1 hour or adjust `MAX_UPLOADS_PER_HOUR`
- **Invalid signature**: Check wallet connection and message format
- **Not a group member**: User must join the group first
- **Upload failed**: Check Filebase credentials and bucket setup

## License

MIT
