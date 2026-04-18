import { ethers } from 'ethers';

export interface BotConfig {
  rpcUrl: string;
  privateKey: string;
  contractAddress: string;
  functionName: string;
  args: any[];
  mode: 'instant' | 'snipe';
  gasPrice?: string; // Total gas price in Gwei
  mintValue?: string; // ETH value
}

export type LogMessage = {
  timestamp: string;
  message: string;
  type: 'info' | 'error' | 'success' | 'warning';
};

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

  async start(config: BotConfig) {
    this.isRunning = true;
    this.log(`Khởi tạo bot cho Contract: ${config.contractAddress}`, 'info');
    
    if (config.mode === 'instant') {
      await this.mint(config);
    } else {
      await this.snipe(config);
    }
  }

  stop() {
    this.isRunning = false;
    this.log('Đã dừng Bot', 'warning');
  }

  async mint(config: BotConfig) {
    try {
      this.log('Đang thực hiện lệnh Mint...', 'info');
      
      // Dynamic ABI detection from args
      const types = config.args.map((arg) => {
        if (typeof arg === 'string' && arg.startsWith('0x') && arg.length === 42) return 'address';
        if (typeof arg === 'number' || typeof arg === 'bigint' || !isNaN(Number(arg))) return 'uint256';
        return 'bytes';
      });

      const abi = [`function ${config.functionName}(${types.join(',')}) payable`];
      const contract = new ethers.Contract(config.contractAddress, abi, this.wallet);
      
      const overrides: any = {};
      
      // Gas price override
      if (config.gasPrice) {
        overrides.gasPrice = ethers.parseUnits(config.gasPrice, 'gwei');
      }

      // Paid mint value override
      if (config.mintValue && parseFloat(config.mintValue) > 0) {
        overrides.value = ethers.parseEther(config.mintValue);
      }

      const tx = await contract[config.functionName](...config.args, overrides);
      
      this.log(`Giao dịch đã gửi: ${tx.hash}`, 'success');
      const receipt = await tx.wait();
      this.log(`Giao dịch thành công tại block ${receipt.blockNumber}`, 'success');
    } catch (error: any) {
      this.log(`Mint thất bại: ${error.message}`, 'error');
    } finally {
      this.isRunning = false;
    }
  }

  async snipe(config: BotConfig) {
    this.log('Chế độ Snipe kích hoạt. Đang kiểm tra trạng thái contract...', 'warning');
    
    const checkAbi = [
      'function paused() view returns (bool)',
      'function publicSaleActive() view returns (bool)',
      'function saleStarted() view returns (bool)',
    ];
    const checker = new ethers.Contract(config.contractAddress, checkAbi, this.provider);

    while (this.isRunning) {
      try {
        let isReady = false;
        
        try {
          const paused = await checker.paused();
          isReady = !paused;
        } catch {
          try {
            const active = await checker.publicSaleActive();
            isReady = active;
          } catch {
            try {
               const started = await checker.saleStarted();
               isReady = started;
            } catch {
               this.log('Không đọc được trạng thái (paused/active). Sẽ thử mint luôn...', 'warning');
               isReady = true; 
            }
          }
        }
        
        if (isReady) {
          this.log('PHÁT HIỆN MINT ĐÃ MỞ! THỰC THI NGAY...', 'success');
          await this.mint(config);
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
