import { create, IPFSHTTPClient } from 'ipfs-http-client';
import { ethers } from 'ethers';
import * as crypto from 'crypto';

interface Message {
  messageId: number;
  sender: string;
  recipient: string;
  encryptedContent: string;
  encryptedMetadata: string;
  timestamp: number;
  txHash: string;
  replyTo: number | null;
  isRead: boolean;
}

interface Thread {
  threadId: string;
  participants: string[];
  subject: string;
  createdAt: number;
  lastMessageAt: number;
  messageCount: number;
  unreadCount: number;
  messages: Message[];
  isGroup: boolean;
}

interface UserMessageFile {
  owner: string;
  publicKey: string;
  currentCID: string;
  ipnsName: string;
  lastUpdated: number;
  version: number;
  threads: Thread[];
  threadIndex: Record<string, number>;
  messageIndex: Record<number, [number, number]>;
}

export class IPFSMessageService {
  private ipfs: IPFSHTTPClient;
  private ipnsKeys: Map<string, any> = new Map();
  private readonly IPNS_NAME = 'k51qzi5uqu5di08xnzm8kk4pkkw611ezndurm0p3gktbdpvmlo1g856a5km42r';
  private readonly ROOT_CID = 'bafybeifvc4knjm2vboquew5pznbgzw74h6jtgzddcrkwgiqr74gfvd2jj4';
  
  constructor() {
    const endpoint = process.env.FILEBASE_ENDPOINT || 'https://s3.filebase.com';
    const accessKey = process.env.FILEBASE_ACCESS_KEY;
    const secretKey = process.env.FILEBASE_SECRET_KEY;
    
    this.ipfs = create({
      url: endpoint,
      headers: {
        Authorization: `Basic ${Buffer.from(`${accessKey}:${secretKey}`).toString('base64')}`
      }
    });
  }
  
  generateThreadId(participants: string[]): string {
    const sorted = participants.map(p => p.toLowerCase()).sort();
    return ethers.keccak256(
      ethers.solidityPacked(
        Array(sorted.length).fill('address'),
        sorted
      )
    );
  }
  
  async initializeUser(
    userAddress: string,
    publicKey: string
  ): Promise<{ ipnsName: string; cid: string }> {
    const initialFile: UserMessageFile = {
      owner: userAddress,
      publicKey,
      currentCID: '',
      ipnsName: this.IPNS_NAME,
      lastUpdated: Date.now(),
      version: 1,
      threads: [],
      threadIndex: {},
      messageIndex: {}
    };
    
    const encrypted = await this.encryptFile(initialFile, publicKey);
    
    // Upload to messages folder in your bucket
    const { cid } = await this.ipfs.add({
      path: `messages/${userAddress}`,
      content: encrypted
    });
    
    initialFile.currentCID = cid.toString();
    
    // Re-encrypt with CID
    const finalEncrypted = await this.encryptFile(initialFile, publicKey);
    const { cid: finalCID } = await this.ipfs.add({
      path: `messages/${userAddress}`,
      content: finalEncrypted
    });
    
    // Note: IPNS publishing would need to be done via Filebase dashboard
    // or with the 'hashd' key that you already have
    
    return {
      ipnsName: this.IPNS_NAME,
      cid: finalCID.toString()
    };
  }
  
  async addMessageToThread(
    userAddress: string,
    userPublicKey: string,
    message: {
      messageId: number;
      sender: string;
      recipient: string;
      encryptedContent: string;
      encryptedMetadata: string;
      timestamp: number;
      txHash: string;
      replyTo: number | null;
      subject?: string;
      participants?: string[];
    }
  ): Promise<string> {
    const file = await this.getUserFile(userAddress, userPublicKey);
    
    const participants = message.participants || [message.sender, message.recipient];
    const threadId = this.generateThreadId(participants);
    
    let threadIdx = file.threadIndex[threadId];
    let thread: Thread;
    
    if (threadIdx === undefined) {
      thread = {
        threadId,
        participants,
        subject: message.subject || 'New conversation',
        createdAt: message.timestamp,
        lastMessageAt: message.timestamp,
        messageCount: 0,
        unreadCount: 0,
        messages: [],
        isGroup: participants.length > 2
      };
      
      threadIdx = file.threads.length;
      file.threads.push(thread);
      file.threadIndex[threadId] = threadIdx;
    } else {
      thread = file.threads[threadIdx];
    }
    
    const messageIdx = thread.messages.length;
    thread.messages.push({
      messageId: message.messageId,
      sender: message.sender,
      recipient: message.recipient,
      encryptedContent: message.encryptedContent,
      encryptedMetadata: message.encryptedMetadata,
      timestamp: message.timestamp,
      txHash: message.txHash,
      replyTo: message.replyTo,
      isRead: message.sender === userAddress
    });
    
    thread.messageCount++;
    thread.lastMessageAt = message.timestamp;
    if (message.sender !== userAddress) {
      thread.unreadCount++;
    }
    
    file.messageIndex[message.messageId] = [threadIdx, messageIdx];
    file.version++;
    file.lastUpdated = Date.now();
    
    const encrypted = await this.encryptFile(file, userPublicKey);
    const { cid } = await this.ipfs.add({
      path: `messages/${userAddress}`,
      content: encrypted
    });
    
    file.currentCID = cid.toString();
    
    const finalEncrypted = await this.encryptFile(file, userPublicKey);
    const { cid: finalCID } = await this.ipfs.add({
      path: `messages/${userAddress}`,
      content: finalEncrypted
    });
    
    // Note: Files uploaded to messages/ folder in your IPNS bucket
    // IPNS k51qzi5uqu5di08xnzm8kk4pkkw611ezndurm0p3gktbdpvmlo1g856a5km42r
    
    return finalCID.toString();
  }
  
  async getUserFile(
    userAddress: string,
    userPrivateKey?: string
  ): Promise<UserMessageFile> {
    try {
      // Fetch directly from messages/{userAddress} path
      const filePath = `messages/${userAddress}`;
      
      const chunks = [];
      for await (const chunk of this.ipfs.cat(filePath)) {
        chunks.push(chunk);
      }
      const encrypted = Buffer.concat(chunks);
      
      if (userPrivateKey) {
        const decrypted = await this.decryptFile(encrypted, userPrivateKey);
        return JSON.parse(decrypted);
      }
      
      return JSON.parse(encrypted.toString());
    } catch (error) {
      console.error('Error fetching user file:', error);
      throw error;
    }
  }
  
  async markAsRead(
    userAddress: string,
    userPublicKey: string,
    messageId: number
  ): Promise<string> {
    const file = await this.getUserFile(userAddress);
    
    const [threadIdx, messageIdx] = file.messageIndex[messageId];
    if (threadIdx === undefined) throw new Error('Message not found');
    
    const thread = file.threads[threadIdx];
    const message = thread.messages[messageIdx];
    
    if (!message.isRead) {
      message.isRead = true;
      thread.unreadCount = Math.max(0, thread.unreadCount - 1);
      file.version++;
      file.lastUpdated = Date.now();
    }
    
    const encrypted = await this.encryptFile(file, userPublicKey);
    const { cid } = await this.ipfs.add({
      path: `messages/${userAddress}`,
      content: encrypted
    });
    
    file.currentCID = cid.toString();
    
    const finalEncrypted = await this.encryptFile(file, userPublicKey);
    const { cid: finalCID } = await this.ipfs.add({
      path: `messages/${userAddress}`,
      content: finalEncrypted
    });
    
    // Note: Files uploaded to messages/ folder in your IPNS bucket
    
    return finalCID.toString();
  }
  
  private async encryptFile(file: UserMessageFile, publicKey: string): Promise<Buffer> {
    const json = JSON.stringify(file, null, 2);
    // TODO: Implement proper encryption with user's public key
    // For now, just return the JSON as buffer
    return Buffer.from(json);
  }
  
  private async decryptFile(encrypted: Buffer, privateKey: string): Promise<string> {
    // TODO: Implement proper decryption with user's private key
    // For now, just return the buffer as string
    return encrypted.toString();
  }
  
  private async getIPNSFromContract(userAddress: string): Promise<string> {
    // TODO: Implement contract call to get IPNS name
    // This will be called from the relayer's contract service
    throw new Error('Not implemented - call from contract service');
  }
}
