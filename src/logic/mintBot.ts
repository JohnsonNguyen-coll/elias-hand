import { ethers } from 'ethers';

export interface BotConfig {
  rpcUrl: string;
  privateKey: string;
  contractAddress: string;
  functionName: string;
  args: any[];
  mode: 'instant' | 'snipe';
  maxPriorityFee?: string; // Total priority fee (tip) in Gwei
  mintValue?: string; // ETH value
  mintType: 'seadrop' | 'custom';
  quantity: number;
}

export type LogMessage = {
  timestamp: string;
  message: string;
  type: 'info' | 'error' | 'success' | 'warning';
};

const SEADROP_ADDRESS = "0x00005EA00Ac477B1030CE78506496e8C2dE24bf5";
const OPEN_SEA_FEE_RECIPIENT = "0x0000a26b00c1F0DF003000390027140000fAa719";

export class MintBot {
  private provider: ethers.JsonRpcProvider;
  private wallet: ethers.Wallet;
  private isRunning: boolean = false;
  private onLog: (log: LogMessage) => void;

  constructor(config: BotConfig, onLog: (log: LogMessage) => void) {
    this.provider = new ethers.JsonRpcProvider(config.rpcUrl);
    this.wallet = new ethers.Wallet(config.privateKey, this.provider);
    this.onLog = onLog;
  }

  private log(message: string, type: LogMessage['type'] = 'info') {
    this.onLog({
      timestamp: new Date().toLocaleTimeString(),
      message,
      type
    });
  }

  private async buildOverrides(config: BotConfig, value?: bigint) {
    const overrides: any = {};

    if (config.maxPriorityFee) {
      const block = await this.provider.getBlock('latest');
      const priorityFee = ethers.parseUnits(config.maxPriorityFee, 'gwei');
      overrides.maxPriorityFeePerGas = priorityFee;
      overrides.maxFeePerGas = block?.baseFeePerGas
        ? (block.baseFeePerGas * 2n) + priorityFee
        : (priorityFee * 3n); // Fallback
    }

    if (value && value > 0n) overrides.value = value;
    return overrides;
  }

  async start(config: BotConfig) {
    this.isRunning = true;
    this.log(`Khởi tạo Bot [${config.mintType.toUpperCase()}] cho Contract: ${config.contractAddress}`, 'info');
    
    if (config.mode === 'instant') {
      if (config.mintType === 'seadrop') {
        await this.mintSeaDrop(config);
      } else {
        await this.mintCustom(config);
      }
    } else {
      await this.snipe(config);
    }
  }

  stop() {
    this.isRunning = false;
    this.log('Đã dừng Bot', 'warning');
  }

  async mintSeaDrop(config: BotConfig) {
    try {
      this.log('Đang đọc cấu hình từ SeaDrop contract...', 'info');
      
      const dropAbi = [`function getPublicDrop(address) view returns (
        tuple(uint80 mintPrice, uint48 startTime, uint48 endTime, 
        uint16 maxTotalMintableByWallet, uint16 feeBps, bool restrictFeeRecipients)
      )`];
      const seadropReader = new ethers.Contract(SEADROP_ADDRESS, dropAbi, this.provider);
      const drop = await seadropReader.getPublicDrop(config.contractAddress);
      
      this.log(`Giá mint SeaDrop: ${ethers.formatEther(drop.mintPrice)} ETH`, 'info');

      const mintAbi = [`function mintPublic(address,address,address,uint256) payable`];
      const seadrop = new ethers.Contract(SEADROP_ADDRESS, mintAbi, this.wallet);

      const qty = BigInt(config.quantity || 1);
      const totalValue = drop.mintPrice * qty;

      const overrides = await this.buildOverrides(config, totalValue);
      
      this.log(`Đang gửi TX Mint SeaDrop (${qty} item)...`, 'warning');
      const tx = await seadrop.mintPublic(
        config.contractAddress,
        OPEN_SEA_FEE_RECIPIENT,
        ethers.ZeroAddress,
        qty,
        overrides
      );

      this.log(`TX đã gửi: ${tx.hash}`, 'success');
      const receipt = await tx.wait();
      this.log(`Thành công tại block ${receipt.blockNumber}`, 'success');
    } catch (error: any) {
      this.log(`Mint SeaDrop thất bại: ${error.message}`, 'error');
    } finally {
      this.isRunning = false;
    }
  }

  async mintCustom(config: BotConfig) {
    try {
      this.log('Đang thực hiện lệnh Custom Mint...', 'info');
      
      const types = config.args.map((arg) => {
        if (typeof arg === 'string' && arg.startsWith('0x') && arg.length === 42) return 'address';
        if (typeof arg === 'number' || typeof arg === 'bigint' || !isNaN(Number(arg))) return 'uint256';
        return 'bytes';
      });

      const abi = [`function ${config.functionName}(${types.join(',')}) payable`];
      const contract = new ethers.Contract(config.contractAddress, abi, this.wallet);
      
      const mintVal = config.mintValue ? ethers.parseEther(config.mintValue) : 0n;
      const overrides = await this.buildOverrides(config, mintVal);

      const tx = await contract[config.functionName](...config.args, overrides);
      
      this.log(`Giao dịch đã gửi: ${tx.hash}`, 'success');
      const receipt = await tx.wait();
      this.log(`Giao dịch thành công tại block ${receipt.blockNumber}`, 'success');
    } catch (error: any) {
      this.log(`Custom Mint thất bại: ${error.message}`, 'error');
    } finally {
      this.isRunning = false;
    }
  }

  async snipe(config: BotConfig) {
    this.log(`Chế độ Snipe [${config.mintType.toUpperCase()}] kích hoạt.`, 'warning');
    
    const dropAbi = [`function getPublicDrop(address) view returns (tuple(uint80 mintPrice, uint48 startTime, uint48 endTime, uint16 maxTotalMintableByWallet, uint16 feeBps, bool restrictFeeRecipients))`];
    const seadropReader = new ethers.Contract(SEADROP_ADDRESS, dropAbi, this.provider);

    const customAbi = [
      'function paused() view returns (bool)',
      'function publicSaleActive() view returns (bool)',
      'function saleStarted() view returns (bool)',
    ];
    const checker = new ethers.Contract(config.contractAddress, customAbi, this.provider);

    while (this.isRunning) {
      try {
        let isReady = false;

        if (config.mintType === 'seadrop') {
          const drop = await seadropReader.getPublicDrop(config.contractAddress);
          const now = Math.floor(Date.now() / 1000);
          isReady = now >= Number(drop.startTime) && now <= Number(drop.endTime);
          if (!isReady) {
             const timeToWait = Number(drop.startTime) - now;
             if (timeToWait > 0) {
               this.log(`Chưa đến giờ mở bán. Cần chờ ${timeToWait} giây...`, 'info');
             } else {
               this.log(`Đã quá giờ mở bán hoặc chưa được configure.`, 'info');
             }
          }
        } else {
          try {
            const paused = await checker.paused();
            isReady = !paused;
          } catch {
            try {
              const active = await checker.publicSaleActive();
              isReady = active;
            } catch {
               isReady = true; 
            }
          }
        }
        
        if (isReady) {
          this.log('PHÁT HIỆN MINT ĐÃ MỞ! THỰC THI NGAY...', 'success');
          if (config.mintType === 'seadrop') {
            await this.mintSeaDrop(config);
          } else {
            await this.mintCustom(config);
          }
          break;
        }
        
        await new Promise(resolve => setTimeout(resolve, 1500));
      } catch (error: any) {
        this.log(`Lỗi khi polling: ${error.message}`, 'error');
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
    }
  }
}
