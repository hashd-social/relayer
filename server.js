import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { ethers } from 'ethers';
import AWS from 'aws-sdk';
import dotenv from 'dotenv';
import { trackUpload, startCleanupCron, getCleanupStats } from './cleanup.js';

dotenv.config();

const app = express();
const upload = multer({ 
  limits: { fileSize: (process.env.MAX_FILE_SIZE_MB || 10) * 1024 * 1024 }
});

// CORS configuration - restrictive for production
app.use(cors({
  origin: function (origin, callback) {
    const allowedOrigins = process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : [];
    
    // In development, allow localhost
    if (process.env.NODE_ENV !== 'production') {
      if (!origin || origin.startsWith('http://localhost:') || origin.startsWith('http://127.0.0.1:')) {
        return callback(null, true);
      }
    }
    
    // Check against allowed origins
    if (allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: false, // Disable credentials for security
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
  exposedHeaders: ['Content-Type']
}));

// Handle preflight requests
app.options('*', cors());

// Security middleware
app.use(express.json({ limit: '1mb' })); // Limit JSON payload size
app.disable('x-powered-by'); // Hide Express signature

// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// Filebase S3 configuration
if (!process.env.FILEBASE_ACCESS_KEY || !process.env.FILEBASE_SECRET_KEY || !process.env.FILEBASE_BUCKET) {
  console.error('❌ Filebase credentials (FILEBASE_ACCESS_KEY, FILEBASE_SECRET_KEY, FILEBASE_BUCKET) are required');
  process.exit(1);
}

const s3 = new AWS.S3({
  endpoint: process.env.FILEBASE_ENDPOINT || 'https://s3.filebase.com',
  accessKeyId: process.env.FILEBASE_ACCESS_KEY,
  secretAccessKey: process.env.FILEBASE_SECRET_KEY,
  s3ForcePathStyle: true,
  signatureVersion: 'v4'
});

// Blockchain provider
if (!process.env.MEGAETH_RPC_URL) {
  console.error('❌ MEGAETH_RPC_URL environment variable is required');
  process.exit(1);
}

const provider = new ethers.JsonRpcProvider(process.env.MEGAETH_RPC_URL);

// MessageContract ABI (minimal - just what we need)
const MESSAGE_CONTRACT_ABI = [
  'function getReadStatus(bytes32 threadId, address participant) view returns (uint256 lastReadIndex, uint256 totalMessages, uint256 unreadCount, uint256 joinedAtIndex)'
];

// MessageContract instance
const messageContract = process.env.MESSAGE_CONTRACT_ADDRESS 
  ? new ethers.Contract(process.env.MESSAGE_CONTRACT_ADDRESS, MESSAGE_CONTRACT_ABI, provider)
  : null;

if (!messageContract) {
  console.warn('⚠️ MESSAGE_CONTRACT_ADDRESS not set - cleanup functionality will be limited');
}

// Contract ABIs (minimal for verification)
const USER_PROFILE_ABI = [
  "function isMember(address user, address groupToken) view returns (bool)"
];

const GROUP_POSTS_ABI = [
  "function groupToken() view returns (address)",
  "function userProfile() view returns (address)",
  "function groupOwner() view returns (address)"
];

const GROUP_FACTORY_ABI = [
  "function getGroupByToken(address tokenAddr) view returns (tuple(string title, string description, string imageURI, address owner, address tokenAddress, address nftAddress, address postsAddress))"
];

const ERC20_ABI = [
  "function owner() view returns (address)"
];

// Rate limiting store (in-memory, use Redis for production)
const rateLimitStore = new Map();

// Rate limiting function (called after multer parses the body)
function checkRateLimit(userAddress) {
  const now = Date.now();
  const hourAgo = now - 3600000;
  const maxUploads = parseInt(process.env.MAX_UPLOADS_PER_HOUR) || 10;

  // Clean old entries
  if (!rateLimitStore.has(userAddress)) {
    rateLimitStore.set(userAddress, []);
  }

  const userUploads = rateLimitStore.get(userAddress).filter(t => t > hourAgo);
  
  if (userUploads.length >= maxUploads) {
    return { 
      allowed: false,
      retryAfter: Math.ceil((userUploads[0] + 3600000 - now) / 1000)
    };
  }

  userUploads.push(now);
  rateLimitStore.set(userAddress, userUploads);
  return { allowed: true };
}

// Verify signature
function verifySignature(message, signature, expectedAddress) {
  try {
    const recoveredAddress = ethers.verifyMessage(message, signature);
    return recoveredAddress.toLowerCase() === expectedAddress.toLowerCase();
  } catch (error) {
    console.error('Signature verification error:', error);
    return false;
  }
}

// Verify group membership
async function verifyMembership(userAddress, groupPostsAddress) {
  try {
    const groupPostsContract = new ethers.Contract(
      groupPostsAddress,
      GROUP_POSTS_ABI,
      provider
    );

    const groupTokenAddress = await groupPostsContract.groupToken();
    const userProfileAddress = await groupPostsContract.userProfile();

    const userProfileContract = new ethers.Contract(
      userProfileAddress,
      USER_PROFILE_ABI,
      provider
    );

    const isMember = await userProfileContract.isMember(userAddress, groupTokenAddress);
    return isMember;
  } catch (error) {
    console.error('Membership verification error:', error);
    return false;
  }
}

// Verify group ownership via token address (for token distribution uploads)
async function verifyTokenOwnership(userAddress, tokenAddress) {
  try {
    console.log(`🔍 Checking ownership of token ${tokenAddress} for user ${userAddress}`);
    
    // Get group info from GroupFactory
    const groupFactoryAddress = process.env.GROUP_FACTORY_ADDRESS;
    if (!groupFactoryAddress) {
      console.error('❌ GROUP_FACTORY_ADDRESS not configured');
      return false;
    }

    const groupFactory = new ethers.Contract(
      groupFactoryAddress,
      GROUP_FACTORY_ABI,
      provider
    );

    // Get group info by token address
    const groupInfo = await groupFactory.getGroupByToken(tokenAddress);
    
    // Check if user is the group owner
    const isOwner = groupInfo.owner.toLowerCase() === userAddress.toLowerCase();
    
    if (isOwner) {
      console.log(`✅ User ${userAddress} is the owner of group with token ${tokenAddress}`);
    } else {
      console.log(`❌ User ${userAddress} is NOT the owner. Owner is: ${groupInfo.owner}`);
    }
    
    return isOwner;
  } catch (error) {
    console.error('Token ownership verification error:', error);
    return false;
  }
}

// Upload encrypted content to Filebase S3 (IPFS-backed)
async function uploadToFilebase(encryptedData, contentHash, folder = 'posts', filename = null) {
  const key = filename ? `${folder}/${filename}` : `${folder}/${contentHash}`;
  
  const params = {
    Bucket: process.env.FILEBASE_BUCKET,
    Key: key,
    Body: encryptedData,
    ContentType: 'application/octet-stream',
    Metadata: {
      'uploaded-at': new Date().toISOString(),
      'content-hash': contentHash
    }
  };

  try {
    const result = await s3.upload(params).promise();
    console.log('S3 upload result:', result);
    
    // Get object metadata to retrieve IPFS CID
    const headResult = await s3.headObject({
      Bucket: params.Bucket,
      Key: key
    }).promise();
    
    console.log('Object metadata:', headResult.Metadata);

    // Filebase stores the IPFS CID in the 'cid' metadata field
    // If not available, we need to construct it from the bucket and key
    let cid = headResult.Metadata?.cid;
    
    if (!cid) {
      // For Filebase IPFS buckets, the CID is available via the gateway
      // We'll use the S3 key as a fallback and let the gateway resolve it
      console.warn('No CID in metadata, using key-based access');
      // Return the key so we can construct the gateway URL
      cid = key;
    }
    
    return {
      cid,
      key,
      location: result.Location
    };
  } catch (error) {
    console.error('Filebase upload error:', error);
    throw error;
  }
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'HASHD IPFS Relayer',
    timestamp: new Date().toISOString()
  });
});

// Upload endpoint
app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    console.log('📥 Upload request received');
    console.log('Body:', req.body);
    console.log('File:', req.file ? 'Present' : 'Missing');
    
    const {
      userAddress,
      groupPostsAddress,
      signature,
      timestamp,
      nonce,
      contentHash,
      folder,
      filename
    } = req.body;

    // Input validation and sanitization
    if (!req.file) {
      return res.status(400).json({ error: 'No file provided' });
    }

    // Validate required fields
    const requiredFields = { userAddress, groupPostsAddress, signature, timestamp, contentHash };
    for (const [field, value] of Object.entries(requiredFields)) {
      if (!value || typeof value !== 'string' || value.trim() === '') {
        console.log(`❌ Missing or invalid ${field}`);
        return res.status(400).json({ error: `${field} is required and must be a non-empty string` });
      }
    }

    // Validate Ethereum addresses
    if (!ethers.isAddress(userAddress)) {
      return res.status(400).json({ error: 'Invalid user address format' });
    }
    if (!ethers.isAddress(groupPostsAddress)) {
      return res.status(400).json({ error: 'Invalid group posts address format' });
    }

    // Validate content hash format (should be 32-byte hex)
    if (!/^0x[a-fA-F0-9]{64}$/.test(contentHash)) {
      return res.status(400).json({ error: 'Invalid content hash format' });
    }

    // Validate timestamp is a number
    const uploadTime = parseInt(timestamp);
    if (isNaN(uploadTime)) {
      return res.status(400).json({ error: 'Invalid timestamp format' });
    }

    // Check rate limit
    const rateLimitResult = checkRateLimit(userAddress.toLowerCase());
    if (!rateLimitResult.allowed) {
      console.log(`⏱️  Rate limit exceeded for ${userAddress}`);
      return res.status(429).json({ 
        error: 'Rate limit exceeded',
        retryAfter: rateLimitResult.retryAfter
      });
    }

    // Check timestamp (within 5 minutes)
    const now = Date.now();
    if (Math.abs(now - uploadTime) > 300000) {
      return res.status(400).json({ error: 'Timestamp expired (must be within 5 minutes)' });
    }

    // Verify content hash (using keccak256 to match frontend)
    const computedHash = ethers.keccak256(req.file.buffer);

    if (computedHash.toLowerCase() !== contentHash.toLowerCase()) {
      console.log(`❌ Hash mismatch: expected ${contentHash}, got ${computedHash}`);
      return res.status(400).json({ error: 'Content hash mismatch' });
    }
    
    console.log('✅ Content hash verified');

    // Verify signature - use same format for all uploads
    const message = `Upload to ${groupPostsAddress}\nHash: ${contentHash}\nTimestamp: ${timestamp}\nNonce: ${nonce}`;
    
    if (folder && folder.startsWith('tokens/')) {
      console.log('📝 Token distribution upload - signature message:', message);
    } else {
      console.log('📝 Regular post upload - signature message:', message);
    }
    
    console.log('🔐 Verifying signature...');
    const isValidSignature = verifySignature(message, signature, userAddress);
    console.log(`🔐 Signature valid: ${isValidSignature}`);
    
    if (!isValidSignature) {
      console.log('❌ Signature verification failed');
      return res.status(401).json({ error: 'Invalid signature' });
    }
    console.log('✅ Signature verified');

    // Verify permissions based on upload type
    if (folder && folder.startsWith('tokens/')) {
      // Token distribution uploads - verify user is the group owner
      // For token uploads, groupPostsAddress is actually the token address
      console.log(`🔍 Verifying ownership for token distribution upload by ${userAddress}`);
      const isOwner = await verifyTokenOwnership(userAddress, groupPostsAddress);
      if (!isOwner) {
        console.log(`❌ Authorization failed for ${userAddress} - not the group owner`);
        return res.status(403).json({ 
          error: 'Not authorized',
          details: 'Only the group owner can upload token distribution data.'
        });
      }
      console.log(`✅ Ownership verified for token distribution upload`);
    } else {
      // Regular post uploads - verify membership via GroupPosts contract
      console.log(`🔍 Verifying membership for ${userAddress} in group ${groupPostsAddress}`);
      const isMember = await verifyMembership(userAddress, groupPostsAddress);
      if (!isMember) {
        console.log(`❌ Membership verification failed for ${userAddress}`);
        return res.status(403).json({ 
          error: 'Not a group member',
          details: 'You must join the group before posting. Please join the group first.'
        });
      }
      console.log(`✅ Membership verified for ${userAddress}`);
    }

    // Upload to Filebase
    const uploadResult = await uploadToFilebase(
      req.file.buffer, 
      contentHash, 
      folder || 'posts',
      filename || null
    );

    console.log(`✅ Upload successful: ${uploadResult.cid} by ${userAddress} (folder: ${folder || 'posts'})`);

    res.json({
      success: true,
      cid: uploadResult.cid,
      contentHash,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ 
      error: 'Upload failed',
      message: error.message 
    });
  }
});

// Unpin endpoint - delete from IPFS
app.post('/api/unpin', async (req, res) => {
  try {
    const { cid, userAddress, signature, timestamp, nonce } = req.body;
    
    console.log('🗑️ Unpin request received');
    console.log('CID:', cid);
    console.log('User:', userAddress);
    
    if (!cid || !userAddress || !signature || !timestamp || !nonce) {
      return res.status(400).json({ 
        error: 'Missing required fields: cid, userAddress, signature, timestamp, nonce' 
      });
    }
    
    // Verify signature
    const message = `Unpin ${cid}\nTimestamp: ${timestamp}\nNonce: ${nonce}`;
    const recoveredAddress = ethers.verifyMessage(message, signature);
    
    if (recoveredAddress.toLowerCase() !== userAddress.toLowerCase()) {
      return res.status(401).json({ error: 'Invalid signature' });
    }
    
    // Check timestamp (must be within 5 minutes)
    const now = Date.now();
    if (Math.abs(now - parseInt(timestamp)) > 300000) {
      return res.status(401).json({ error: 'Request expired' });
    }
    
    // Find the S3 key for this CID
    // List objects in the bucket to find the one with this CID
    const bucket = process.env.FILEBASE_BUCKET;
    
    try {
      const listParams = {
        Bucket: bucket,
        MaxKeys: 1000
      };
      
      const listedObjects = await s3.listObjectsV2(listParams).promise();
      let keyToDelete = null;
      
      // Find the object with matching CID in metadata
      for (const obj of listedObjects.Contents || []) {
        const headParams = {
          Bucket: bucket,
          Key: obj.Key
        };
        
        try {
          const headData = await s3.headObject(headParams).promise();
          const objCid = headData.Metadata?.cid;
          
          if (objCid === cid) {
            keyToDelete = obj.Key;
            break;
          }
        } catch (err) {
          console.warn(`Could not get metadata for ${obj.Key}:`, err.message);
        }
      }
      
      if (!keyToDelete) {
        console.log(`⚠️ CID ${cid} not found in bucket, may have been already deleted`);
        return res.json({ 
          success: true, 
          message: 'CID not found or already deleted' 
        });
      }
      
      // Delete the object
      const deleteParams = {
        Bucket: bucket,
        Key: keyToDelete
      };
      
      await s3.deleteObject(deleteParams).promise();
      console.log(`✅ Deleted ${keyToDelete} (CID: ${cid})`);
      
      res.json({ 
        success: true, 
        cid,
        message: 'Successfully unpinned from IPFS' 
      });
      
    } catch (s3Error) {
      console.error('S3 error:', s3Error);
      throw new Error(`Failed to unpin from Filebase: ${s3Error.message}`);
    }
    
  } catch (error) {
    console.error('❌ Unpin error:', error);
    res.status(500).json({ 
      error: 'Unpin failed',
      message: error.message 
    });
  }
});

// Get upload stats (for monitoring)
app.get('/api/stats', (req, res) => {
  const stats = {
    activeUsers: rateLimitStore.size,
    totalUploadsLastHour: Array.from(rateLimitStore.values())
      .flat()
      .filter(t => t > Date.now() - 3600000)
      .length
  };
  res.json(stats);
});

// Public endpoint to get merkle data by token address
app.get('/api/merkle/:tokenAddress', async (req, res) => {
  try {
    const { tokenAddress } = req.params;
    const key = `merkle/${tokenAddress.toLowerCase()}.json`;
    
    console.log(`📥 Merkle data request for token: ${tokenAddress}`);
    
    const params = {
      Bucket: process.env.FILEBASE_BUCKET,
      Key: key
    };
    
    const data = await s3.getObject(params).promise();
    const merkleData = JSON.parse(data.Body.toString());
    
    res.json({
      success: true,
      data: merkleData
    });
  } catch (error) {
    console.error('❌ Error fetching merkle data:', error.message);
    res.status(404).json({
      success: false,
      message: 'Merkle data not found for this token'
    });
  }
});

// Helper to upload JSON to S3/IPFS
async function uploadJSONToIPFS(data, path) {
  const jsonString = JSON.stringify(data, null, 2);
  const buffer = Buffer.from(jsonString);
  
  const params = {
    Bucket: process.env.FILEBASE_BUCKET,
    Key: path,
    Body: buffer,
    ContentType: 'application/json',
    Metadata: {
      'uploaded-at': new Date().toISOString()
    }
  };
  
  const result = await s3.upload(params).promise();
  
  // Get CID from metadata
  const headResult = await s3.headObject({
    Bucket: params.Bucket,
    Key: path
  }).promise();
  
  return {
    cid: headResult.Metadata?.cid || path,
    key: path,
    location: result.Location
  };
}

// Message endpoints (SHARED THREAD FILES)
app.post('/api/messages/send', async (req, res) => {
  try {
    const {
      // Signed message from frontend (already has hash and signature)
      signedMessage,
      threadId
    } = req.body;
    
    console.log('📨 Message send request:', { 
      threadId, 
      sender: signedMessage.sender,
      participants: signedMessage.participants,
      index: signedMessage.index
    });
    
    // Check contract first to get the true on-chain message count
    // Use getReadStatus with the sender as participant to get totalMessages
    let contractMessageCount = 0;
    if (messageContract) {
      try {
        console.log(`📊 Checking contract at ${process.env.MESSAGE_CONTRACT_ADDRESS} for thread ${threadId}`);
        const [lastReadIndex, totalMessages, unreadCount, joinedAtIndex] = 
          await messageContract.getReadStatus(threadId, signedMessage.sender);
        contractMessageCount = Number(totalMessages);
        console.log(`📊 Contract says thread has ${contractMessageCount} messages`);
      } catch (error) {
        console.log('📊 Thread does not exist on contract yet (new thread)');
        console.log('   Error:', error.message);
      }
    } else {
      console.log('⚠️ MessageContract not initialized!');
    }
    
    // Get or create shared thread file
    // CONTRACT IS SOURCE OF TRUTH - only fetch from S3 if contract has messages
    let threadFile;
    const threadKey = `threads/${threadId}`;
    if (contractMessageCount > 0) {
      // Contract has messages, fetch from S3
      try {
        const threadData = await s3.getObject({
          Bucket: process.env.FILEBASE_BUCKET,
          Key: threadKey
        }).promise();
        threadFile = JSON.parse(threadData.Body.toString());
        
        console.log(`📂 Found existing thread with ${threadFile.messages.length} messages in IPFS`);
        
        // IMPORTANT: Truncate to only confirmed messages (remove orphaned unconfirmed ones)
        if (threadFile.messages.length > contractMessageCount) {
          console.log(`⚠️ IPFS has ${threadFile.messages.length - contractMessageCount} orphaned messages, truncating to ${contractMessageCount}`);
          threadFile.messages = threadFile.messages.slice(0, contractMessageCount);
        }
      } catch (err) {
        // S3 file missing but contract has messages - this shouldn't happen
        console.warn('⚠️ Contract has messages but S3 file missing, creating new file');
        threadFile = {
          threadId: threadId,
          participants: signedMessage.participants.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())),
          version: 0,
          lastUpdated: Date.now(),
          messages: []
        };
      }
    } else {
      // Contract has 0 messages, start fresh (ignore any orphaned S3 data)
      console.log(`📂 Creating new thread (contract has 0 messages)`);
      threadFile = {
        threadId: threadId,
        participants: signedMessage.participants.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())),
        version: 0,
        lastUpdated: Date.now(),
        messages: []
      };
    }
    
    // Verify message index matches expected (CONTRACT is source of truth)
    const expectedIndex = messageContract ? contractMessageCount : threadFile.messages.length;
    if (signedMessage.index !== expectedIndex) {
      throw new Error(`Index mismatch: expected ${expectedIndex}, got ${signedMessage.index}`);
    }
    
    // Verify prevHash matches last CONFIRMED message (if not first message)
    // Use contractMessageCount, not threadFile.messages.length (which may include unconfirmed)
    if (contractMessageCount > 0) {
      const lastConfirmedIndex = contractMessageCount - 1;
      const lastMessage = threadFile.messages[lastConfirmedIndex];
      if (!lastMessage) {
        throw new Error(`Cannot find confirmed message at index ${lastConfirmedIndex}`);
      }
      if (signedMessage.prevHash !== lastMessage.hash) {
        throw new Error(`Chain broken: prevHash ${signedMessage.prevHash} does not match last confirmed message hash ${lastMessage.hash}`);
      }
      console.log(`✅ prevHash matches last confirmed message (index ${lastConfirmedIndex})`);
    } else {
      // First message should have zero hash as prevHash
      const zeroHash = '0x0000000000000000000000000000000000000000000000000000000000000000';
      if (signedMessage.prevHash !== zeroHash) {
        throw new Error('First message must have zero prevHash');
      }
    }
    
    // Add message to thread
    threadFile.messages.push(signedMessage);
    threadFile.version++;
    threadFile.lastUpdated = Date.now();
    
    // Upload updated thread file
    const threadUpload = await uploadJSONToIPFS(threadFile, threadKey);
    console.log('✅ Thread file uploaded:', threadUpload.cid);
    console.log(`   Messages in thread: ${threadFile.messages.length}`);
    console.log(`   Chain valid: ${signedMessage.prevHash === (threadFile.messages.length > 1 ? threadFile.messages[threadFile.messages.length - 2].hash : '0x0000000000000000000000000000000000000000000000000000000000000000')}`);
    
    // Track upload for cleanup verification
    trackUpload(threadUpload.cid, threadId, signedMessage.index, signedMessage.sender);
    
    // Note: On-chain recording will be done by the frontend
    // The sender will sign a transaction to record the thread CID
    console.log('💾 IPFS upload complete. Frontend should now record on-chain.');
    
    res.json({
      success: true,
      messageId: signedMessage.messageId,
      threadCID: threadUpload.cid,
      messageIndex: signedMessage.index,
      threadMessageCount: threadFile.messages.length
    });
  } catch (error) {
    console.error('Message send error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get thread file by threadId
app.get('/api/threads/:threadId', async (req, res) => {
  try {
    const { threadId } = req.params;
    
    console.log('📥 Get thread:', threadId);
    
    try {
      // Try to fetch thread file with metadata (includes CID)
      const headData = await s3.headObject({
        Bucket: process.env.FILEBASE_BUCKET,
        Key: `threads/${threadId}`
      }).promise();
      
      const data = await s3.getObject({
        Bucket: process.env.FILEBASE_BUCKET,
        Key: `threads/${threadId}`
      }).promise();
      
      const threadFile = JSON.parse(data.Body.toString());
      const cid = headData.Metadata?.cid || null;
      
      console.log(`✅ Found thread with ${threadFile.messages?.length || 0} messages`);
      console.log(`   Participants: ${threadFile.participants.join(', ')}`);
      console.log(`   CID: ${cid || 'not available'}`);
      
      res.json({
        success: true,
        data: threadFile,
        cid: cid
      });
    } catch (err) {
      // Thread doesn't exist yet
      console.log(`📭 Thread not found: ${threadId}`);
      res.status(404).json({ 
        success: false,
        error: 'Thread not found'
      });
    }
  } catch (error) {
    console.error('Get thread error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Global error handler
app.use((error, req, res, next) => {
  console.error('Unhandled error:', error);
  res.status(500).json({ 
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? error.message : 'Something went wrong'
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ 
    error: 'Endpoint not found',
    message: `${req.method} ${req.path} is not a valid endpoint`
  });
});

// Cleanup stats endpoint
app.get('/api/cleanup/stats', (req, res) => {
  try {
    const stats = getCleanupStats();
    res.json({ success: true, stats });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Startup validation
function validateEnvironment() {
  const required = ['MEGAETH_RPC_URL', 'FILEBASE_ACCESS_KEY', 'FILEBASE_SECRET_KEY', 'FILEBASE_BUCKET'];
  const missing = required.filter(key => !process.env[key]);
  
  if (missing.length > 0) {
    console.error('❌ Missing required environment variables:', missing.join(', '));
    console.error('   Please check your .env file');
    process.exit(1);
  }
  
  // Validate numeric values
  const maxUploads = parseInt(process.env.MAX_UPLOADS_PER_HOUR || '10');
  const maxFileSize = parseInt(process.env.MAX_FILE_SIZE_MB || '10');
  const cleanupInterval = parseInt(process.env.CLEANUP_INTERVAL_MINUTES || '5');
  
  if (isNaN(maxUploads) || maxUploads < 1) {
    console.error('❌ MAX_UPLOADS_PER_HOUR must be a positive number');
    process.exit(1);
  }
  
  if (isNaN(maxFileSize) || maxFileSize < 1) {
    console.error('❌ MAX_FILE_SIZE_MB must be a positive number');
    process.exit(1);
  }
  
  if (isNaN(cleanupInterval) || cleanupInterval < 1) {
    console.error('❌ CLEANUP_INTERVAL_MINUTES must be a positive number');
    process.exit(1);
  }
  
  return { maxUploads, maxFileSize, cleanupInterval };
}

// Graceful shutdown
function setupGracefulShutdown(server) {
  const shutdown = (signal) => {
    console.log(`\n⚠️  Received ${signal}, shutting down gracefully...`);
    server.close(() => {
      console.log('✅ HTTP server closed');
      process.exit(0);
    });
    
    // Force close after 10 seconds
    setTimeout(() => {
      console.error('❌ Could not close connections in time, forcefully shutting down');
      process.exit(1);
    }, 10000);
  };
  
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

const PORT = process.env.PORT || 3001;
const { cleanupInterval } = validateEnvironment();

const server = app.listen(PORT, () => {
  console.log(`🚀 HASHD IPFS Relayer v${process.env.npm_package_version || '1.0.0'}`);
  console.log(`   Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`   Port: ${PORT}`);
  console.log(`   RPC: ${process.env.MEGAETH_RPC_URL}`);
  console.log(`   Bucket: ${process.env.FILEBASE_BUCKET}`);
  console.log(`   Rate limit: ${process.env.MAX_UPLOADS_PER_HOUR || 10} uploads/hour`);
  console.log(`   Max file size: ${process.env.MAX_FILE_SIZE_MB || 10}MB`);
  console.log(`   Cleanup interval: ${cleanupInterval} minutes`);
  console.log(`   Message contract: ${messageContract ? 'Connected' : 'Not configured'}`);
  
  // Start cleanup cron job
  startCleanupCron(messageContract, s3, process.env.FILEBASE_BUCKET, cleanupInterval);
  
  console.log('✅ Server ready for requests');
});

setupGracefulShutdown(server);
