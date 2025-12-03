import { Router } from 'express';
import { IPFSMessageService } from '../services/ipfs-message-service';
import { ethers } from 'ethers';

const router = Router();
const ipfsService = new IPFSMessageService();

router.post('/initialize', async (req, res) => {
  try {
    const { userAddress, publicKey } = req.body;
    
    if (!userAddress || !publicKey) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    const result = await ipfsService.initializeUser(userAddress, publicKey);
    
    res.json({
      success: true,
      ipnsName: result.ipnsName,
      cid: result.cid
    });
  } catch (error: any) {
    console.error('Initialize user error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/send', async (req, res) => {
  try {
    const {
      sender,
      recipient,
      senderPublicKey,
      recipientPublicKey,
      senderEncryptedContent,
      recipientEncryptedContent,
      senderEncryptedMetadata,
      recipientEncryptedMetadata,
      subject,
      replyTo,
      txHash
    } = req.body;
    
    if (!sender || !recipient || !senderEncryptedContent || !recipientEncryptedContent) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    const messageId = Date.now();
    const timestamp = Math.floor(Date.now() / 1000);
    
    const senderCID = await ipfsService.addMessageToThread(
      sender,
      senderPublicKey,
      {
        messageId,
        sender,
        recipient,
        encryptedContent: senderEncryptedContent,
        encryptedMetadata: senderEncryptedMetadata,
        timestamp,
        txHash: txHash || '',
        replyTo: replyTo || null,
        subject
      }
    );
    
    const recipientCID = await ipfsService.addMessageToThread(
      recipient,
      recipientPublicKey,
      {
        messageId,
        sender,
        recipient,
        encryptedContent: recipientEncryptedContent,
        encryptedMetadata: recipientEncryptedMetadata,
        timestamp,
        txHash: txHash || '',
        replyTo: replyTo || null,
        subject
      }
    );
    
    res.json({
      success: true,
      messageId,
      senderCID,
      recipientCID
    });
  } catch (error: any) {
    console.error('Send message error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/mark-read', async (req, res) => {
  try {
    const { userAddress, userPublicKey, messageId } = req.body;
    
    if (!userAddress || !userPublicKey || !messageId) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    const cid = await ipfsService.markAsRead(userAddress, userPublicKey, messageId);
    
    res.json({
      success: true,
      cid
    });
  } catch (error: any) {
    console.error('Mark as read error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/user/:address', async (req, res) => {
  try {
    const { address } = req.params;
    const { privateKey } = req.query;
    
    if (!address) {
      return res.status(400).json({ error: 'Missing user address' });
    }
    
    const file = await ipfsService.getUserFile(address, privateKey as string);
    
    res.json({
      success: true,
      data: file
    });
  } catch (error: any) {
    console.error('Get user messages error:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
