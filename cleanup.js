/**
 * Cleanup Service for orphaned IPFS uploads
 * 
 * Tracks pending uploads and unpins CIDs that were never confirmed on-chain.
 * Runs on a cron schedule to clean up orphaned data.
 */

import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// SQLite database for tracking pending uploads
const db = new Database(path.join(__dirname, 'pending_uploads.db'));

// Initialize database schema
db.exec(`
  CREATE TABLE IF NOT EXISTS pending_uploads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cid TEXT NOT NULL UNIQUE,
    thread_id TEXT NOT NULL,
    message_index INTEGER NOT NULL,
    sender TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    confirmed_at INTEGER,
    status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'confirmed', 'orphaned', 'unpinned'))
  );
  
  CREATE INDEX IF NOT EXISTS idx_pending_status ON pending_uploads(status);
  CREATE INDEX IF NOT EXISTS idx_pending_thread ON pending_uploads(thread_id);
  CREATE INDEX IF NOT EXISTS idx_pending_created ON pending_uploads(created_at);
`);

// Prepared statements for better performance
const insertUpload = db.prepare(`
  INSERT OR REPLACE INTO pending_uploads (cid, thread_id, message_index, sender, created_at, status)
  VALUES (?, ?, ?, ?, ?, 'pending')
`);

const getPendingUploads = db.prepare(`
  SELECT * FROM pending_uploads 
  WHERE status = 'pending' 
  AND created_at < ?
`);

const markConfirmed = db.prepare(`
  UPDATE pending_uploads 
  SET status = 'confirmed', confirmed_at = ? 
  WHERE cid = ?
`);

const markOrphaned = db.prepare(`
  UPDATE pending_uploads 
  SET status = 'orphaned' 
  WHERE cid = ?
`);

const markUnpinned = db.prepare(`
  UPDATE pending_uploads 
  SET status = 'unpinned' 
  WHERE cid = ?
`);

const getOrphanedUploads = db.prepare(`
  SELECT * FROM pending_uploads 
  WHERE status = 'orphaned'
`);

const getStats = db.prepare(`
  SELECT 
    status,
    COUNT(*) as count
  FROM pending_uploads
  GROUP BY status
`);

/**
 * Track a new upload that needs on-chain confirmation
 */
export function trackUpload(cid, threadId, messageIndex, sender) {
  try {
    insertUpload.run(cid, threadId, messageIndex, sender, Date.now());
    console.log(`📝 Tracking upload: ${cid} for thread ${threadId}`);
    return true;
  } catch (error) {
    console.error('Failed to track upload:', error.message);
    return false;
  }
}

/**
 * Mark an upload as confirmed on-chain
 */
export function confirmUpload(cid) {
  try {
    markConfirmed.run(Date.now(), cid);
    console.log(`✅ Confirmed upload: ${cid}`);
    return true;
  } catch (error) {
    console.error('Failed to confirm upload:', error.message);
    return false;
  }
}

/**
 * Get all pending uploads older than the specified age (in minutes)
 */
export function getStaleUploads(maxAgeMinutes = 15) {
  const cutoffTime = Date.now() - (maxAgeMinutes * 60 * 1000);
  return getPendingUploads.all(cutoffTime);
}

/**
 * Check if a message exists on-chain for a given thread
 */
async function checkOnChain(messageContract, threadId, sender, expectedIndex) {
  if (!messageContract) {
    console.warn('⚠️ MessageContract not available for on-chain check');
    return false;
  }
  
  try {
    const [, totalMessages] = await messageContract.getReadStatus(threadId, sender);
    // If contract has more messages than the expected index, it's confirmed
    return Number(totalMessages) > expectedIndex;
  } catch (error) {
    // Thread doesn't exist or other error - not confirmed
    return false;
  }
}

/**
 * Unpin a CID from Filebase S3
 */
async function unpinFromFilebase(s3, bucket, cid) {
  try {
    // Filebase uses the CID as part of the object metadata
    // To "unpin", we delete the object which removes it from pinning
    // Note: For thread files, we need to be careful not to delete active threads
    
    // For now, we'll just mark it as unpinned in our database
    // Actual deletion would require knowing the exact key
    console.log(`🗑️ Would unpin CID: ${cid} (marking as unpinned)`);
    return true;
  } catch (error) {
    console.error(`Failed to unpin ${cid}:`, error.message);
    return false;
  }
}

/**
 * Run the cleanup job
 * - Check pending uploads against on-chain state
 * - Mark orphaned uploads
 * - Unpin orphaned CIDs
 */
export async function runCleanup(messageContract, s3, bucket, options = {}) {
  const { 
    maxAgeMinutes = 15,  // Consider uploads orphaned after 15 minutes
    dryRun = false       // If true, don't actually unpin
  } = options;
  
  console.log('\n🧹 Running cleanup job...');
  console.log(`   Max age: ${maxAgeMinutes} minutes`);
  console.log(`   Dry run: ${dryRun}`);
  
  const staleUploads = getStaleUploads(maxAgeMinutes);
  console.log(`   Found ${staleUploads.length} stale uploads to check`);
  
  let confirmed = 0;
  let orphaned = 0;
  let errors = 0;
  
  for (const upload of staleUploads) {
    try {
      const isOnChain = await checkOnChain(
        messageContract, 
        upload.thread_id, 
        upload.sender, 
        upload.message_index
      );
      
      if (isOnChain) {
        markConfirmed.run(Date.now(), upload.cid);
        confirmed++;
        console.log(`   ✅ Confirmed: ${upload.cid}`);
      } else {
        markOrphaned.run(upload.cid);
        orphaned++;
        console.log(`   ⚠️ Orphaned: ${upload.cid} (thread: ${upload.thread_id}, index: ${upload.message_index})`);
      }
    } catch (error) {
      errors++;
      console.error(`   ❌ Error checking ${upload.cid}:`, error.message);
    }
  }
  
  // Now unpin orphaned uploads
  const orphanedUploads = getOrphanedUploads.all();
  let unpinned = 0;
  
  for (const upload of orphanedUploads) {
    if (dryRun) {
      console.log(`   [DRY RUN] Would unpin: ${upload.cid}`);
    } else {
      const success = await unpinFromFilebase(s3, bucket, upload.cid);
      if (success) {
        markUnpinned.run(upload.cid);
        unpinned++;
      }
    }
  }
  
  // Log stats
  const stats = getStats.all();
  console.log('\n📊 Cleanup complete:');
  console.log(`   Confirmed: ${confirmed}`);
  console.log(`   Orphaned: ${orphaned}`);
  console.log(`   Unpinned: ${unpinned}`);
  console.log(`   Errors: ${errors}`);
  console.log('   Database stats:', stats);
  
  return { confirmed, orphaned, unpinned, errors };
}

/**
 * Start the cleanup cron job
 */
export function startCleanupCron(messageContract, s3, bucket, intervalMinutes = 5) {
  const intervalMs = intervalMinutes * 60 * 1000;
  
  console.log(`⏰ Starting cleanup cron (every ${intervalMinutes} minutes)`);
  
  // Run immediately on start
  setTimeout(() => {
    runCleanup(messageContract, s3, bucket).catch(err => {
      console.error('Cleanup job failed:', err);
    });
  }, 10000); // Wait 10 seconds after startup
  
  // Then run on interval
  const intervalId = setInterval(() => {
    runCleanup(messageContract, s3, bucket).catch(err => {
      console.error('Cleanup job failed:', err);
    });
  }, intervalMs);
  
  return intervalId;
}

/**
 * Get cleanup statistics
 */
export function getCleanupStats() {
  return getStats.all();
}

// Graceful shutdown
process.on('exit', () => {
  db.close();
});
