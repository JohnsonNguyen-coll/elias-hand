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

  private formatCountdown(seconds: number) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    return `${h}h ${m}m ${s}s`;
  }

  private async buildOverrides(config: BotConfig, value?: bigint) {
    const overrides: any = {};

    if (config.maxPriorityFee) {
      const [feeData, block] = await Promise.all([
        this.provider.getFeeData(),
        this.provider.getBlock('latest')
      ]);
      const priorityFee = ethers.parseUnits(config.maxPriorityFee, 'gwei');
      overrides.maxPriorityFeePerGas = priorityFee;
      
      const baseFee = block?.baseFeePerGas;
      overrides.maxFeePerGas = baseFee
        ? (baseFee * 2n) + priorityFee
        : (priorityFee * 3n);
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
      
      try {
        this.log('Đang ước tính Gas (Estimate)...', 'info');
        const estGas = await seadrop.mintPublic.estimateGas(
            config.contractAddress,
            OPEN_SEA_FEE_RECIPIENT,
            ethers.ZeroAddress,
            qty,
            overrides
        );
        overrides.gasLimit = (estGas * 12n) / 10n; // Add 20% margin
      } catch (e) {
        this.log('Không thể ước tính Gas, dùng Default Gas Limit', 'warning');
        overrides.gasLimit = 500000n;
      }

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
        if (typeof arg === 'boolean') return 'bool';
        if (typeof arg === 'string' && arg.startsWith('0x') && arg.length === 42) return 'address';
        if (typeof arg === 'number' || typeof arg === 'bigint' || (!isNaN(Number(arg)) && typeof arg !== 'object')) return 'uint256';
        return 'bytes';
      });

      const abi = [`function ${config.functionName}(${types.join(',')}) payable`];
      const contract = new ethers.Contract(config.contractAddress, abi, this.wallet);
      
      const mintVal = config.mintValue ? ethers.parseEther(config.mintValue) : 0n;
      const overrides = await this.buildOverrides(config, mintVal);

      try {
        const estGas = await contract[config.functionName].estimateGas(...config.args, overrides);
        overrides.gasLimit = (estGas * 12n) / 10n;
      } catch (e) {
        overrides.gasLimit = 500000n;
      }

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

    let lastLogTime = 0;

    while (this.isRunning) {
      try {
        let isReady = false;
        let timeToWait = 0;

        if (config.mintType === 'seadrop') {
          const drop = await seadropReader.getPublicDrop(config.contractAddress);
          const now = Math.floor(Date.now() / 1000);
          
          const hasNotEnded = drop.endTime === 0n || now <= Number(drop.endTime);
          isReady = drop.startTime > 0n && now >= Number(drop.startTime) && hasNotEnded;
          timeToWait = Number(drop.startTime) - now;

          if (!isReady) {
             const currentTime = Date.now();
             if (currentTime - lastLogTime > 30000) {
               if (timeToWait > 0) {
                 this.log(`Chưa đến giờ. Còn ${this.formatCountdown(timeToWait)}...`, 'info');
               } else if (drop.startTime === 0n) {
                 this.log(`SeaDrop chưa config (startTime=0).`, 'warning');
               } else {
                 this.log(`Đợt drop đã kết thúc.`, 'info');
               }
               lastLogTime = currentTime;
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
               isReady = false; // Chuyển từ true -> false để an toàn 
            }
          }
          
          if (!isReady) {
             const currentTime = Date.now();
             if (currentTime - lastLogTime > 30000) {
                this.log(`Đang chờ contract mở Mint...`, 'info');
                lastLogTime = currentTime;
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
