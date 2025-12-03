import { ethers } from 'ethers';

const provider = new ethers.JsonRpcProvider('http://127.0.0.1:8545');
const groupFactoryAddress = '0x610178dA211FEF7D417bC0e6FeD39F05609AD788';
const tokenAddress = '0x193198556d1DbF455Aa063050eC1Cb039E8acECf';

const GROUP_FACTORY_ABI = [
  "function getGroupByToken(address tokenAddr) view returns (tuple(address tokenAddr, address nftAddr, address postsAddr, address owner, string name, string description, string imageUrl, uint256 createdAt, bool isActive))",
  "function tokenToGroupIndex(address) view returns (uint256)",
  "function groups(uint256) view returns (tuple(address tokenAddr, address nftAddr, address postsAddr, address owner, string name, string description, string imageUrl, uint256 createdAt, bool isActive))"
];

async function checkGroup() {
  try {
    const groupFactory = new ethers.Contract(groupFactoryAddress, GROUP_FACTORY_ABI, provider);
    
    console.log('Checking token:', tokenAddress);
    console.log('GroupFactory:', groupFactoryAddress);
    
    // Try to get group index
    try {
      const index = await groupFactory.tokenToGroupIndex(tokenAddress);
      console.log('Group index:', index.toString());
      
      const group = await groupFactory.groups(index);
      console.log('\nGroup data:');
      console.log('  Token:', group.tokenAddr);
      console.log('  Owner:', group.owner);
      console.log('  Name:', group.name);
      console.log('  Active:', group.isActive);
    } catch (e) {
      console.log('tokenToGroupIndex failed:', e.message);
    }
    
    // Try direct lookup
    try {
      const groupInfo = await groupFactory.getGroupByToken(tokenAddress);
      console.log('\nDirect lookup succeeded:');
      console.log('  Owner:', groupInfo.owner);
      console.log('  Name:', groupInfo.name);
    } catch (e) {
      console.log('\nDirect lookup failed:', e.message);
      console.log('This means the token is not registered in GroupFactory');
    }
    
  } catch (error) {
    console.error('Error:', error);
  }
}

checkGroup();
