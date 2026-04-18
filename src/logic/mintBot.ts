import { ethers } from 'ethers';

export interface BotConfig {
  rpcUrl: string;
  privateKey: string;
  contractAddress: string;
  functionName: string;
  args: any[];
  mode: 'instant' | 'snipe';
  maxPriorityFee?: string;
  maxFee?: string;
  mintValue?: string;
  mintType: 'seadrop' | 'custom';
  quantity: number;
}

export type LogMessage = {
  timestamp: string;
  message: string;
  type: 'info' | 'error' | 'success' | 'warning';
};

const SEADROP_ADDRESS = "0x00005EA00Ac477B1030CE78506496e8C2dE24bf5";
// SeaDrop v2 / ERC721SeaDrop v2 address
const SEADROP_V2_ADDRESS = "0x0000000000664ceffed39244a8312bD895470803";
const OPEN_SEA_FEE_RECIPIENT = "0x0000a26b00c1F0DF003000390027140000fAa719";

export class MintBot {
  private provider: ethers.JsonRpcProvider;
  private wallet: ethers.Wallet;
  private isRunning: boolean = false;
  private onLog: (log: LogMessage) => void;

  constructor(config: BotConfig, onLog: (log: LogMessage) => void) {
    if (config.rpcUrl.startsWith('ws')) {
      this.provider = new (ethers as any).WebSocketProvider(config.rpcUrl);
    } else {
      this.provider = new ethers.JsonRpcProvider(config.rpcUrl, undefined, {
        batchMaxCount: 1
      });
    }
    this.wallet = new ethers.Wallet(config.privateKey, this.provider);
    this.onLog = onLog;
  }

  private log(message: string, type: LogMessage['type'] = 'info') {
    this.onLog({ timestamp: new Date().toLocaleTimeString(), message, type });
  }

  private formatCountdown(seconds: number) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    return `${h}h ${m}m ${s}s`;
  }

  private async buildOverrides(config: BotConfig, value?: bigint) {
    const overrides: any = {};
    if (config.maxPriorityFee || config.maxFee) {
      const priorityFee = config.maxPriorityFee ? ethers.parseUnits(config.maxPriorityFee, 'gwei') : 0n;
      overrides.maxPriorityFeePerGas = priorityFee;
      if (config.maxFee) {
        overrides.maxFeePerGas = ethers.parseUnits(config.maxFee, 'gwei');
      } else {
        const block = await this.provider.getBlock('latest');
        const baseFee = block?.baseFeePerGas;
        overrides.maxFeePerGas = baseFee
          ? (baseFee * 15n / 10n) + priorityFee
          : (priorityFee * 3n);
      }
    }
    if (value && value > 0n) overrides.value = value;
    return overrides;
  }

  /**
   * FIX CHÍNH: Resolve SeaDrop address một lần duy nhất,
   * thử nhiều candidates (v1, v2, onchain list).
   * Trả về { seaDropAddress, mintPrice } hoặc throw nếu không tìm được drop hợp lệ.
   */
  private async resolveSeaDrop(contractAddress: string): Promise<{ seaDropAddress: string; mintPrice: bigint }> {
    const nftAbi = [
      `function getAllowedSeaDrop() view returns (address[])`,
      `function getAllowedERC721SeaDrop() view returns (address[])`,
    ];
    const dropAbi = [
      `function getPublicDrop(address) view returns (
        tuple(uint80 mintPrice, uint48 startTime, uint48 endTime,
        uint16 maxTotalMintableByWallet, uint16 feeBps, bool restrictFeeRecipients)
      )`,
    ];

    // Tập hợp candidates: đọc từ contract trước, rồi fallback hardcoded
    let candidates: string[] = [];

    const nftContract = new ethers.Contract(contractAddress, nftAbi, this.provider);

    // Thử getAllowedSeaDrop (v1 interface)
    try {
      const allowed: string[] = await nftContract.getAllowedSeaDrop();
      if (allowed?.length > 0) {
        candidates.push(...allowed);
        this.log(`Tìm thấy ${allowed.length} SeaDrop address từ contract`, 'info');
      }
    } catch { /* không hỗ trợ v1 */ }

    // Thử getAllowedERC721SeaDrop (v2 interface)
    try {
      const allowed2: string[] = await nftContract.getAllowedERC721SeaDrop();
      if (allowed2?.length > 0) {
        candidates.push(...allowed2);
        this.log(`Tìm thấy ${allowed2.length} ERC721SeaDrop address (v2) từ contract`, 'info');
      }
    } catch { /* không hỗ trợ v2 */ }

    // Thêm hardcoded fallbacks nếu chưa có
    if (!candidates.includes(SEADROP_ADDRESS)) candidates.push(SEADROP_ADDRESS);
    if (!candidates.includes(SEADROP_V2_ADDRESS)) candidates.push(SEADROP_V2_ADDRESS);

    // Thử từng candidate, lấy cái đầu tiên trả về drop hợp lệ
    for (const addr of candidates) {
      try {
        const reader = new ethers.Contract(addr, dropAbi, this.provider);
        const drop = await reader.getPublicDrop(contractAddress);
        this.log(`SeaDrop address hợp lệ: ${addr} | Giá: ${ethers.formatEther(drop.mintPrice)} ETH`, 'info');
        return { seaDropAddress: addr, mintPrice: drop.mintPrice };
      } catch {
        this.log(`${addr} không trả về drop hợp lệ, thử tiếp...`, 'warning');
      }
    }

    throw new Error('Không tìm được SeaDrop address hợp lệ cho contract này. Contract có thể không dùng SeaDrop standard.');
  }

  async start(config: BotConfig) {
    this.isRunning = true;
    this.log(`Khởi tạo Bot [${config.mintType.toUpperCase()}] cho Contract: ${config.contractAddress}`, 'info');

    try {
      if (config.mode === 'instant') {
        if (config.mintType === 'seadrop') {
          await this.mintSeaDrop(config);
        } else {
          await this.mintCustom(config);
        }
      } else {
        await this.snipe(config);
      }
    } finally {
      this.isRunning = false;
    }
  }

  stop() {
    this.isRunning = false;
    this.log('Đã dừng Bot', 'warning');
  }

  async mintSeaDrop(config: BotConfig, resolvedSeaDrop?: { seaDropAddress: string; mintPrice: bigint }) {
    try {
      this.log('Đang đọc cấu hình từ SeaDrop contract...', 'info');

      // Dùng resolved address từ snipe nếu có, không thì resolve mới
      const { seaDropAddress, mintPrice } = resolvedSeaDrop ?? await this.resolveSeaDrop(config.contractAddress);

      this.log(`Giá mint SeaDrop: ${ethers.formatEther(mintPrice)} ETH`, 'info');

      // Pre-flight: kiểm tra số dư ví
      const qty = BigInt(config.quantity || 1);
      const totalValue = mintPrice * qty;
      const walletBalance = await this.provider.getBalance(this.wallet.address);
      this.log(`Số dư ví: ${ethers.formatEther(walletBalance)} ETH | Cần: ${ethers.formatEther(totalValue)} ETH (chưa tính gas)`, 'info');
      if (walletBalance < totalValue) {
        this.log(`❌ Ví không đủ ETH để mint! Cần ít nhất ${ethers.formatEther(totalValue)} ETH`, 'error');
        return;
      }

      const mintAbi = [`function mintPublic(address,address,address,uint256) payable`];
      const seadrop = new ethers.Contract(seaDropAddress, mintAbi, this.wallet);
      const overrides = await this.buildOverrides(config, totalValue);

      // Estimate gas với giá trị thực
      try {
        this.log('Đang ước tính Gas (Estimate)...', 'info');
        const estGas = await seadrop.mintPublic.estimateGas(
          config.contractAddress,
          OPEN_SEA_FEE_RECIPIENT,
          ethers.ZeroAddress,
          qty,
          { ...overrides, gasLimit: 500000n }
        );
        overrides.gasLimit = (estGas * 12n) / 10n;
        this.log(`Gas ước tính: ${estGas.toString()} → Dùng: ${overrides.gasLimit.toString()}`, 'info');
      } catch (e: any) {
        this.log(`Estimate gas thất bại: ${e.message}`, 'error');

        // Debug: thử staticCall để xem revert reason rõ hơn
        try {
          await seadrop.mintPublic.staticCall(
            config.contractAddress,
            OPEN_SEA_FEE_RECIPIENT,
            ethers.ZeroAddress,
            qty,
            { ...overrides, gasLimit: 500000n }
          );
        } catch (staticErr: any) {
          const reason = staticErr?.revert?.args?.[0] ?? staticErr?.reason ?? staticErr?.message ?? 'unknown';
          this.log(`Revert reason: ${reason}`, 'error');
        }

        this.log('Hủy TX để tránh mất gas vô ích!', 'error');
        return;
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
      this.log(`Check TX: https://blockscan.com/tx/${tx.hash}`, 'info');
      const receipt = await tx.wait();
      if (receipt?.status === 1) {
        this.log(`✅ Mint thành công tại block ${receipt.blockNumber}`, 'success');
      } else {
        this.log(`❌ TX revert tại block ${receipt?.blockNumber}`, 'error');
      }
    } catch (error: any) {
      this.log(`Mint SeaDrop thất bại: ${error.message}`, 'error');
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
        const estGas = await contract[config.functionName].estimateGas(...config.args, { ...overrides, gasLimit: 500000n });
        overrides.gasLimit = (estGas * 12n) / 10n;
      } catch (e: any) {
        if (e.message.includes('insufficient funds')) {
          this.log('Lỗi: Ví không đủ tiền để thực hiện giao dịch!', 'error');
          return;
        }
        overrides.gasLimit = 500000n;
      }

      const tx = await contract[config.functionName](...config.args, overrides);
      this.log(`Giao dịch đã gửi: ${tx.hash}`, 'success');
      this.log(`Check TX: https://blockscan.com/tx/${tx.hash}`, 'info');
      const receipt = await tx.wait();
      this.log(`Giao dịch thành công tại block ${receipt.blockNumber}`, 'success');
    } catch (error: any) {
      this.log(`Custom Mint thất bại: ${error.message}`, 'error');
    }
  }

  async snipe(config: BotConfig) {
    this.log(`Chế độ Snipe [${config.mintType.toUpperCase()}] kích hoạt.`, 'warning');

    // FIX: Resolve SeaDrop address MỘT LẦN ở đây, truyền vào mintSeaDrop
    let resolvedSeaDrop: { seaDropAddress: string; mintPrice: bigint } | undefined;

    if (config.mintType === 'seadrop') {
      try {
        resolvedSeaDrop = await this.resolveSeaDrop(config.contractAddress);
      } catch (e: any) {
        this.log(`Snipe warning: ${e.message}. Sẽ re-resolve khi mint.`, 'warning');
      }
    }

    const dropAbi = [`function getPublicDrop(address) view returns (
      tuple(uint80 mintPrice, uint48 startTime, uint48 endTime,
      uint16 maxTotalMintableByWallet, uint16 feeBps, bool restrictFeeRecipients)
    )`];

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
          // Dùng seaDropAddress đã resolve, không fallback sai
          const seaDropAddr = resolvedSeaDrop?.seaDropAddress ?? SEADROP_ADDRESS;
          const seadropReader = new ethers.Contract(seaDropAddr, dropAbi, this.provider);

          try {
            const drop = await seadropReader.getPublicDrop(config.contractAddress);
            const now = Math.floor(Date.now() / 1000);
            const hasNotEnded = drop.endTime === 0n || now <= Number(drop.endTime);
            isReady = drop.startTime > 0n && now >= Number(drop.startTime) && hasNotEnded;
            timeToWait = Number(drop.startTime) - now;

            // Update mintPrice nếu đã resolve
            if (resolvedSeaDrop) resolvedSeaDrop.mintPrice = drop.mintPrice;

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
          } catch (e: any) {
            // getPublicDrop thất bại → re-resolve
            this.log(`Lỗi đọc drop state, đang re-resolve...`, 'warning');
            try {
              resolvedSeaDrop = await this.resolveSeaDrop(config.contractAddress);
            } catch { /* giữ nguyên */ }
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
              isReady = false;
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
            await this.mintSeaDrop(config, resolvedSeaDrop); // truyền resolved address
          } else {
            await this.mintCustom(config);
          }
          break;
        }

        await new Promise(resolve => setTimeout(resolve, 500));
      } catch (error: any) {
        this.log(`Lỗi khi polling: ${error.message}`, 'error');
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
    }
  }
}