import { MaxUint256, parseEther, Wallet, ZeroAddress } from 'ethers';
import { ethers } from 'hardhat';
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from './shared/expect';
import { TEST_FEE_RECEIVER, antiSniperPluginFixture } from './shared/fixtures';
import { PLUGIN_FLAGS, encodePriceSqrt, getMaxTick, getMinTick } from './shared/utilities';

import { MockPool, MockTimeAlgebraAntiSniperPluginV1, MockTimeAntiSniperPluginFactory, MockTimeVirtualPool, TestERC20 } from '../typechain';

import BigNumber from 'bignumber.js';

describe('AlgebraAntiSniperPluginV1', () => {
  let wallet: Wallet, other: Wallet;

  let plugin: MockTimeAlgebraAntiSniperPluginV1; // modified plugin
  let mockPool: MockPool; // mock of AlgebraPool
  let mockPluginFactory: MockTimeAntiSniperPluginFactory; // modified plugin factory

  let minTick = getMinTick(60);
  let maxTick = getMaxTick(60);

  async function initializeAtZeroTick(pool: MockPool) {
    await pool.initialize(encodePriceSqrt(1, 1));
  }

  const FEE_DENOMINATOR = new BigNumber('1000000'); // Constants.FEE_DENOMINATOR

  function getPluginFeeUsingPoolInput(amountIn: string, poolFee: string, auxFee: string): string {
    const amount = new BigNumber(amountIn);
    const lastFee = new BigNumber(poolFee);
    const additionalFee = new BigNumber(auxFee);

    // poolFee = (amountIn * lastFee) / FEE_DENOMINATOR
    const poolFeeAmount = amount.multipliedBy(lastFee).dividedToIntegerBy(FEE_DENOMINATOR);

    // netFromPool = amountIn - poolFee
    const netFromPool = amount.minus(poolFeeAmount);

    // targetFeeRate = poolFeeRate + pluginFeeRate
    const targetFeeRate = lastFee.plus(additionalFee);

    // totalCost = netFromPool / (1 - targetFeeRate)
    const totalCost = netFromPool.multipliedBy(FEE_DENOMINATOR).dividedToIntegerBy(FEE_DENOMINATOR.minus(targetFeeRate));

    // pluginFee = totalCost - netFromPool - poolFee
    const pluginFee = totalCost.minus(netFromPool).minus(poolFeeAmount);

    return pluginFee.toFixed(0); // return as string with no decimals
  }

  async function skipAuxFee() {
    const now = await time.latest();
    const period = 1000;
    let newStartTimestamp = now + period;
    await plugin.setStartTimestamp(newStartTimestamp);

    const [, , periodSetup] = await plugin.feeConfig();
    const finalTimestamp = newStartTimestamp + Number(periodSetup);
    await time.increaseTo(finalTimestamp);
  }

  before('prepare signers', async () => {
    [wallet, other] = await (ethers as any).getSigners();
  });

  beforeEach('deploy test AlgebraBasePluginV1', async () => {
    ({ plugin, mockPool, mockPluginFactory } = await loadFixture(antiSniperPluginFixture));
    mockPluginFactory.addModifyLiquidityEntrypoint(wallet.address);
  });

  describe('#Initialize', async () => {
    it('cannot initialize twice', async () => {
      await mockPool.setPlugin(plugin);
      await initializeAtZeroTick(mockPool);

      await plugin.initialize();
      await expect(plugin.initialize()).to.be.revertedWith('Already initialized');
    });

    it('cannot initialize detached plugin', async () => {
      await initializeAtZeroTick(mockPool);
      await expect(plugin.initialize()).to.be.revertedWith('Plugin not attached');
    });

    it('cannot initialize if pool not initialized', async () => {
      await mockPool.setPlugin(plugin);
      await expect(plugin.initialize()).to.be.revertedWith('Pool is not initialized');
    });
  });

  // plain tests for hooks functionality
  describe('#Hooks', () => {
    it('only pool can call hooks', async () => {
      const errorMessage = 'Only pool can call this';
      await expect(plugin.beforeInitialize(wallet.address, 100)).to.be.revertedWith(errorMessage);
      await expect(plugin.afterInitialize(wallet.address, 100, 100)).to.be.revertedWith(errorMessage);
      await expect(plugin.beforeModifyPosition(wallet.address, wallet.address, 100, 100, 100, '0x')).to.be.revertedWith(errorMessage);
      await expect(plugin.afterModifyPosition(wallet.address, wallet.address, 100, 100, 100, 100, 100, '0x')).to.be.revertedWith(errorMessage);
      await expect(plugin.beforeSwap(wallet.address, wallet.address, true, 100, 100, false, '0x')).to.be.revertedWith(errorMessage);
      await expect(plugin.afterSwap(wallet.address, wallet.address, true, 100, 100, 100, 100, '0x')).to.be.revertedWith(errorMessage);
      await expect(plugin.beforeFlash(wallet.address, wallet.address, 100, 100, '0x')).to.be.revertedWith(errorMessage);
      await expect(plugin.afterFlash(wallet.address, wallet.address, 100, 100, 100, 100, '0x')).to.be.revertedWith(errorMessage);
    });

    describe('not implemented hooks', async () => {
      let defaultConfig: bigint;

      beforeEach('connect plugin to pool', async () => {
        defaultConfig = await plugin.defaultPluginConfig();
        await mockPool.setPlugin(plugin);
      });

      it('resets config after afterModifyPosition', async () => {
        await mockPool.initialize(encodePriceSqrt(1, 1));
        await mockPool.setPluginConfig(PLUGIN_FLAGS.AFTER_POSITION_MODIFY_FLAG);
        expect((await mockPool.globalState()).pluginConfig).to.be.eq(PLUGIN_FLAGS.AFTER_POSITION_MODIFY_FLAG);
        await mockPool.mint(wallet.address, wallet.address, 0, 60, 100, '0x');
        expect((await mockPool.globalState()).pluginConfig).to.be.eq(defaultConfig);
      });

      it('resets config after afterSwap', async () => {
        await mockPool.initialize(encodePriceSqrt(1, 1));
        await mockPool.setPluginConfig(PLUGIN_FLAGS.AFTER_SWAP_FLAG);
        expect((await mockPool.globalState()).pluginConfig).to.be.eq(PLUGIN_FLAGS.AFTER_SWAP_FLAG);
        await mockPool['swapToTick(int24)'](100);
        expect((await mockPool.globalState()).pluginConfig).to.be.eq(defaultConfig);
      });

      it('resets config after beforeFlash', async () => {
        await mockPool.setPluginConfig(PLUGIN_FLAGS.BEFORE_FLASH_FLAG);
        expect((await mockPool.globalState()).pluginConfig).to.be.eq(PLUGIN_FLAGS.BEFORE_FLASH_FLAG);
        await mockPool.flash(wallet.address, 100, 100, '0x');
        expect((await mockPool.globalState()).pluginConfig).to.be.eq(defaultConfig);
      });

      it('resets config after afterFlash', async () => {
        await mockPool.setPluginConfig(PLUGIN_FLAGS.AFTER_FLASH_FLAG);
        expect((await mockPool.globalState()).pluginConfig).to.be.eq(PLUGIN_FLAGS.AFTER_FLASH_FLAG);
        await mockPool.flash(wallet.address, 100, 100, '0x');
        expect((await mockPool.globalState()).pluginConfig).to.be.eq(defaultConfig);
      });
    });

    /// Anti Snipe beforeSwap hook

    describe('anti snipe tests', async () => {
      let token0: TestERC20;
      let token1: TestERC20;
      const Q96 = '79228162514264337593543950336';
      const POOL_FEE = 10000;

      function isToken0PluginFee(zeroToOne: boolean, amount: string | bigint) {
        if (typeof amount === 'bigint') return amount >= 0n ? zeroToOne : !zeroToOne;
        else return new BigNumber(amount).gte(0) ? zeroToOne : !zeroToOne;
      }

      async function processAndValidateSwap(amountIn: bigint, zeroForOne: boolean, isValidate?: boolean) {
        const pluginAddress = await plugin.getAddress();

        const absAmount = (amountIn > 0 ? amountIn : -amountIn).toString();
        const _isToken0 = isToken0PluginFee(zeroForOne, amountIn);
        const token = _isToken0 ? token0 : token1;

        const [, , , , _currentAuxFee] = await plugin.feeConfig();
        const auxFeeAmount = getPluginFeeUsingPoolInput(absAmount, POOL_FEE.toString(), _currentAuxFee.toString());

        if (_isToken0) {
          await token0.mint(wallet.address, auxFeeAmount);
          await token0.connect(wallet).approve(pluginAddress, MaxUint256);
        } else {
          await token1.mint(wallet.address, auxFeeAmount);
          await token1.connect(wallet).approve(pluginAddress, MaxUint256);
        }

        const _balanceFeeReceiver = await token.balanceOf(TEST_FEE_RECEIVER);
        const _balanceUser = await token.balanceOf(wallet.address);

        await mockPool.connect(wallet)['swapToTick(int24,bool,int256)'](100, zeroForOne, amountIn);

        const balanceFeeReceiver_ = await token.balanceOf(TEST_FEE_RECEIVER);
        const balanceUser_ = await token.balanceOf(wallet.address);

        const diffFeeReceiver = balanceFeeReceiver_ - _balanceFeeReceiver;
        const diffUser = _balanceUser - balanceUser_;

        if (isValidate) {
          expect(diffFeeReceiver).to.eq(auxFeeAmount);
          expect(diffUser).to.eq(auxFeeAmount);
        }

        return { diffFeeReceiver, diffUser };
      }

      beforeEach('connect plugin to pool', async () => {
        const erc20Factory = await ethers.getContractFactory('TestERC20');

        const _tokenA = (await erc20Factory.deploy(0)) as any as TestERC20;
        const _tokenA_address = await _tokenA.getAddress();
        const _tokenB = (await erc20Factory.deploy(0)) as any as TestERC20;
        const _tokenB_address = await _tokenB.getAddress();
        [token0, token1] = _tokenA_address.toLocaleLowerCase() < _tokenB_address.toLocaleLowerCase() ? [_tokenA, _tokenB] : [_tokenB, _tokenA];
        await mockPool.setTokens(await token0.getAddress(), await token1.getAddress());

        const defaultConfig = await plugin.defaultPluginConfig();

        await mockPool.setPlugin(plugin);
        await mockPool.initialize(Q96);
        await mockPool.setPluginConfig(BigInt(PLUGIN_FLAGS.BEFORE_SWAP_FLAG) | defaultConfig);
        await plugin.initialize();
        await mockPool.setFee(POOL_FEE);
      });

      it('reverts when trading disabled prior to start timestamp', async () => {
        const now = await time.latest();
        const period = 1000;
        let newStartTimestamp = now + period;
        await plugin.setStartTimestamp(newStartTimestamp);

        const defaultConfig = await plugin.defaultPluginConfig();
        await mockPool.setPlugin(plugin);
        await mockPool.setPluginConfig(BigInt(PLUGIN_FLAGS.BEFORE_SWAP_FLAG) | defaultConfig);
        await expect(mockPool.connect(other)['swapToTick(int24,bool,int256)'](100, true, 0)).to.be.revertedWith('Trading disabled');
        expect((await mockPool.globalState()).pluginConfig).to.be.eq(BigInt(PLUGIN_FLAGS.AFTER_SWAP_FLAG) | defaultConfig);
      });
      it('charges starting fee when trading prior start is enabled', async () => {
        const now = await time.latest();
        const period = 1000;
        let newStartTimestamp = now + period;
        await plugin.setStartTimestamp(newStartTimestamp);

        const [, _feeReceiver, _period, _startingFee] = await plugin.feeConfig();
        expect(_startingFee).to.be.eq(490_000);

        await plugin.setAuxFeeData({
          period: _period,
          disabledPriorStart: false,
          feeReceiver: _feeReceiver,
          startingFee: _startingFee,
        });

        /// Total cost is 99
        /// Pool input 50 = (49.5 + 0.5)
        /// Plugin fee = 49
        const amountIn = parseEther('50');
        const zeroForOne = true;

        await processAndValidateSwap(amountIn, zeroForOne, true);
      });

      it('charges anti snipe fees through out the period', async () => {
        const now = await time.latest();
        const period = 1000;
        let newStartTimestamp = now + period;
        await plugin.setStartTimestamp(newStartTimestamp);
        await time.increaseTo(newStartTimestamp);

        const [, _feeReceiver, _period, _startingFee] = await plugin.feeConfig();
        expect(_startingFee).to.be.eq(490_000);

        const amountIn = parseEther('50');
        const zeroForOne = true;

        const chunck = 10;
        const count = Math.floor(Number(_period) / chunck);
        let lastFeeReceived = 0n;

        // Tests fee decaying throughout the period
        for (let i = 0; i < count; i++) {
          const { diffFeeReceiver } = await processAndValidateSwap(amountIn, zeroForOne, false);
          if (lastFeeReceived != 0n) expect(diffFeeReceiver).lt(lastFeeReceived);
          lastFeeReceived = diffFeeReceiver;
          await time.increase(chunck);
        }

        await time.increase(chunck);

        // Zero fee upon conclusion
        const { diffFeeReceiver } = await processAndValidateSwap(amountIn, zeroForOne, false);
        expect(diffFeeReceiver).eq(0n);
      });

      it('charges proper token according to (zeroToOne) and (amount) arguments', async () => {
        const now = await time.latest();
        const period = 1000;
        let newStartTimestamp = now + period;
        await plugin.setStartTimestamp(newStartTimestamp);

        const [, _feeReceiver, _period, _startingFee] = await plugin.feeConfig();
        expect(_startingFee).to.be.eq(490_000);

        await plugin.setAuxFeeData({
          period: _period,
          disabledPriorStart: false,
          feeReceiver: _feeReceiver,
          startingFee: _startingFee,
        });

        let zeroForOne = true;
        const amountIn = parseEther('50');
        const negAmountIn = -parseEther('50');
        let amount = amountIn;

        await processAndValidateSwap(amount, zeroForOne, true);
        amount = negAmountIn;
        await processAndValidateSwap(amount, zeroForOne, true);

        zeroForOne = false;
        amount = amountIn;
        await processAndValidateSwap(amount, zeroForOne, true);
        amount = negAmountIn;
        await processAndValidateSwap(amount, zeroForOne, true);
      });

      it('swap without extra fee for a exempted address', async () => {
        const now = await time.latest();

        const period = 1000;
        let newStartTimestamp = now + period;
        await plugin.setStartTimestamp(newStartTimestamp);

        // exempt address from extra fee
        await plugin.exempt([wallet.address], true);

        const amountIn = parseEther('50');
        const zeroForOne = true;

        // trade before trading start - trading disabled prior to start timestamp
        const { diffFeeReceiver } = await processAndValidateSwap(amountIn, zeroForOne, false);
        expect(diffFeeReceiver).to.eq(0);

        const [, _feeReceiver, _period, _startingFee] = await plugin.feeConfig();
        await plugin.setAuxFeeData({
          period: _period,
          disabledPriorStart: false,
          feeReceiver: _feeReceiver,
          startingFee: _startingFee,
        });

        // trade before trading start - trading disabled prior to start timestamp
        const { diffFeeReceiver: diffFeeReceiver2 } = await processAndValidateSwap(amountIn, zeroForOne, false);
        expect(diffFeeReceiver2).to.eq(0);

        await time.increaseTo(newStartTimestamp);

        // trade after trading starts
        const { diffFeeReceiver: diffFeeReceiver3 } = await processAndValidateSwap(amountIn, zeroForOne, false);
        expect(diffFeeReceiver3).to.eq(0);

        await time.increase(_period);

        // trade after trading concludes
        const { diffFeeReceiver: diffFeeReceiver4 } = await processAndValidateSwap(amountIn, zeroForOne, false);
        expect(diffFeeReceiver4).to.eq(0);
      });
    });
  });

  describe('#FarmingPlugin', () => {
    describe('virtual pool tests', () => {
      let virtualPoolMock: MockTimeVirtualPool;

      beforeEach('deploy virtualPoolMock', async () => {
        await mockPluginFactory.setFarmingAddress(wallet);
        const virtualPoolMockFactory = await ethers.getContractFactory('MockTimeVirtualPool');
        virtualPoolMock = (await virtualPoolMockFactory.deploy()) as any as MockTimeVirtualPool;
      });

      it('set incentive works', async () => {
        await mockPool.setPlugin(plugin);
        await plugin.setIncentive(virtualPoolMock);
        expect(await plugin.incentive()).to.be.eq(await virtualPoolMock.getAddress());
      });

      it('can detach incentive', async () => {
        await mockPool.setPlugin(plugin);
        await plugin.setIncentive(virtualPoolMock);
        await plugin.setIncentive(ZeroAddress);
        expect(await plugin.incentive()).to.be.eq(ZeroAddress);
      });

      it('can detach incentive even if no more has rights to connect plugins', async () => {
        await mockPool.setPlugin(plugin);
        await plugin.setIncentive(virtualPoolMock);
        await mockPluginFactory.setFarmingAddress(other);
        await plugin.setIncentive(ZeroAddress);
        expect(await plugin.incentive()).to.be.eq(ZeroAddress);
      });

      it('cannot attach incentive even if no more has rights to connect plugins', async () => {
        await mockPool.setPlugin(plugin);
        await plugin.setIncentive(virtualPoolMock);
        await mockPluginFactory.setFarmingAddress(other);
        await expect(plugin.setIncentive(other)).to.be.revertedWith('Not allowed to set incentive');
      });

      it('new farming can detach old incentive', async () => {
        await mockPool.setPlugin(plugin);
        await plugin.setIncentive(virtualPoolMock);
        await mockPluginFactory.setFarmingAddress(other);
        await plugin.connect(other).setIncentive(ZeroAddress);
        expect(await plugin.incentive()).to.be.eq(ZeroAddress);
      });

      it('cannot detach incentive if nothing connected', async () => {
        await mockPool.setPlugin(plugin);
        await expect(plugin.setIncentive(ZeroAddress)).to.be.revertedWith('Already active');
        expect(await plugin.incentive()).to.be.eq(ZeroAddress);
      });

      it('cannot set same incentive twice', async () => {
        await mockPool.setPlugin(plugin);
        await plugin.setIncentive(virtualPoolMock);
        await expect(plugin.setIncentive(virtualPoolMock)).to.be.revertedWith('Already active');
      });

      it('cannot set incentive if has active', async () => {
        await mockPool.setPlugin(plugin);
        await plugin.setIncentive(virtualPoolMock);
        await expect(plugin.setIncentive(wallet.address)).to.be.revertedWith('Has active incentive');
      });

      it('can detach incentive if not connected to pool', async () => {
        const defaultConfig = await plugin.defaultPluginConfig();
        await mockPool.setPlugin(plugin);
        await mockPool.setPluginConfig(BigInt(PLUGIN_FLAGS.AFTER_SWAP_FLAG) | defaultConfig);
        await plugin.setIncentive(virtualPoolMock);
        expect(await plugin.incentive()).to.be.eq(await virtualPoolMock.getAddress());
        await mockPool.setPlugin(ZeroAddress);
        await plugin.setIncentive(ZeroAddress);
        expect(await plugin.incentive()).to.be.eq(ZeroAddress);
      });

      it('can set incentive if afterSwap hook is active', async () => {
        const defaultConfig = await plugin.defaultPluginConfig();
        await mockPool.setPlugin(plugin);
        await mockPool.setPluginConfig(BigInt(PLUGIN_FLAGS.AFTER_SWAP_FLAG) | defaultConfig);
        await plugin.setIncentive(virtualPoolMock);
        expect(await plugin.incentive()).to.be.eq(await virtualPoolMock.getAddress());
        expect((await mockPool.globalState()).pluginConfig).to.be.eq(BigInt(PLUGIN_FLAGS.AFTER_SWAP_FLAG) | defaultConfig);
      });

      it('set incentive works only for PluginFactory.farmingAddress', async () => {
        await mockPluginFactory.setFarmingAddress(ZeroAddress);
        await expect(plugin.setIncentive(virtualPoolMock)).to.be.revertedWith('Not allowed to set incentive');
      });

      it('incentive can not be attached if plugin is not attached', async () => {
        await expect(plugin.setIncentive(virtualPoolMock)).to.be.revertedWith('Plugin not attached');
      });

      it('incentive attached before initialization', async () => {
        await skipAuxFee();
        await mockPool.setPlugin(plugin);

        await plugin.setIncentive(virtualPoolMock);
        await mockPool.initialize(encodePriceSqrt(1, 1));
        await mockPool.mint(wallet.address, wallet.address, -120, 120, 1, '0x');
        await mockPool.mint(wallet.address, wallet.address, minTick, maxTick, 1, '0x');

        await mockPool['swapToTick(int24)'](-130);

        expect(await plugin.incentive()).to.be.eq(await virtualPoolMock.getAddress());
        expect(await plugin.isIncentiveConnected(virtualPoolMock)).to.be.true;

        const tick = (await mockPool.globalState()).tick;
        expect(await virtualPoolMock.currentTick()).to.be.eq(tick);
        expect(await virtualPoolMock.timestamp()).to.be.gt(0);
      });

      it('incentive attached after initialization', async () => {
        await skipAuxFee();

        await mockPool.setPlugin(plugin);
        await mockPool.initialize(encodePriceSqrt(1, 1));
        await plugin.setIncentive(virtualPoolMock);

        await mockPool.mint(wallet.address, wallet.address, -120, 120, 1, '0x');
        await mockPool.mint(wallet.address, wallet.address, minTick, maxTick, 1, '0x');

        await mockPool['swapToTick(int24)'](-130);

        expect(await plugin.incentive()).to.be.eq(await virtualPoolMock.getAddress());
        expect(await plugin.isIncentiveConnected(virtualPoolMock)).to.be.true;

        const tick = (await mockPool.globalState()).tick;
        expect(await virtualPoolMock.currentTick()).to.be.eq(tick);
        expect(await virtualPoolMock.timestamp()).to.be.gt(0);
      });

      it.skip('swap with finished incentive', async () => {
        /*await virtualPoolMock.setIsExist(false);
         await mockPool.setIncentive(virtualPoolMock.address);
         await mockPool.initialize(encodePriceSqrt(1, 1));
         await mint(wallet.address, -120, 120, 1);
         await mint(wallet.address, minTick, maxTick, 1);
         expect(await mockPool.activeIncentive()).to.be.eq(virtualPoolMock.address);    
   
         await swapToLowerPrice(encodePriceSqrt(1, 2), wallet.address);
   
         expect(await mockPool.activeIncentive()).to.be.eq(ethers.constants.AddressZero);
         expect(await virtualPoolMock.currentTick()).to.be.eq(0);
         expect(await virtualPoolMock.timestamp()).to.be.eq(0);
         */
      });

      it.skip('swap with not started yet incentive', async () => {
        /*
         await virtualPoolMock.setIsStarted(false);
         await mockPool.setIncentive(virtualPoolMock.address);
         await mockPool.initialize(encodePriceSqrt(1, 1));
         await mint(wallet.address, -120, 120, 1);
         await mint(wallet.address, minTick, maxTick, 1);
         expect(await mockPool.activeIncentive()).to.be.eq(virtualPoolMock.address);    
   
         await swapToLowerPrice(encodePriceSqrt(1, 2), wallet.address);
   
         const tick = (await mockPool.globalState()).tick;
         expect(await mockPool.activeIncentive()).to.be.eq(virtualPoolMock.address);
         expect(await virtualPoolMock.currentTick()).to.be.eq(tick);
         expect(await virtualPoolMock.timestamp()).to.be.eq(0); 
         */
      });
    });

    describe('#isIncentiveConnected', () => {
      let virtualPoolMock: MockTimeVirtualPool;

      beforeEach('deploy virtualPoolMock', async () => {
        await mockPluginFactory.setFarmingAddress(wallet);
        const virtualPoolMockFactory = await ethers.getContractFactory('MockTimeVirtualPool');
        virtualPoolMock = (await virtualPoolMockFactory.deploy()) as any as MockTimeVirtualPool;
      });

      it('true with active incentive', async () => {
        await mockPool.setPlugin(plugin);
        await plugin.setIncentive(virtualPoolMock);
        expect(await plugin.isIncentiveConnected(virtualPoolMock)).to.be.true;
      });

      it('false with invalid address', async () => {
        await mockPool.setPlugin(plugin);
        await plugin.setIncentive(virtualPoolMock);
        expect(await plugin.isIncentiveConnected(wallet.address)).to.be.false;
      });

      it('false if plugin detached', async () => {
        await mockPool.setPlugin(plugin);
        await plugin.setIncentive(virtualPoolMock);
        await mockPool.setPlugin(ZeroAddress);
        expect(await plugin.isIncentiveConnected(virtualPoolMock)).to.be.false;
      });

      it('false if hook deactivated', async () => {
        await mockPool.setPlugin(plugin);
        await plugin.setIncentive(virtualPoolMock);
        await mockPool.setPluginConfig(0);
        expect(await plugin.isIncentiveConnected(virtualPoolMock)).to.be.false;
      });
    });

    describe('#Incentive', () => {
      it('incentive is not detached after swap', async () => {
        await skipAuxFee();

        await mockPool.setPlugin(plugin);
        await initializeAtZeroTick(mockPool);
        await mockPluginFactory.setFarmingAddress(wallet.address);

        const vpStubFactory = await ethers.getContractFactory('MockTimeVirtualPool');
        let vpStub = (await vpStubFactory.deploy()) as any as MockTimeVirtualPool;

        await plugin.setIncentive(vpStub);
        const initLiquidityAmount = 10000000000n;
        await mockPool.mint(wallet.address, wallet.address, -120, 120, initLiquidityAmount, '0x');
        await mockPool.mint(wallet.address, wallet.address, -1200, 1200, initLiquidityAmount, '0x');
        await mockPool['swapToTick(int24)'](-200);

        expect(await plugin.incentive()).to.be.eq(await vpStub.getAddress());
      });
    });
  });

  describe('AlgebraBasePluginV1 external methods', () => {
    describe('#exempt', () => {
      let users: string[] = [];
      before(() => {
        users = [wallet.address, other.address];
      });
      it('only plugin manager', async () => {
        await expect(plugin.connect(other).exempt([], true)).to.be.reverted;
      });
      it('exempt plugin fees', async () => {
        await plugin.exempt(users, true);
        for (let user of users) {
          const isExempted = await plugin.isExempted(user);
          expect(isExempted).to.eq(true);
        }
      });
      it('unexempt plugin fees', async () => {
        await plugin.exempt(users, true);
        await plugin.exempt(users, false);
        for (let user of users) {
          const isExempted = await plugin.isExempted(user);
          expect(isExempted).to.eq(false);
        }
      });
    });
    describe('#setStartTimestamp', () => {
      it('only plugin manager', async () => {
        await expect(plugin.connect(other).setStartTimestamp(0)).to.be.reverted;
      });

      it('updates start timestamp', async () => {
        const now = await time.latest();
        const period = 1000;
        let newStartTimestamp = now + period;
        await plugin.setStartTimestamp(newStartTimestamp);
        let [startTimestamp] = await plugin.feeConfig();
        expect(startTimestamp).to.eq(newStartTimestamp);

        await time.increaseTo(now + period - 2);
        newStartTimestamp = newStartTimestamp + period;
        await plugin.setStartTimestamp(newStartTimestamp);
        [startTimestamp] = await plugin.feeConfig();
        expect(startTimestamp).to.eq(newStartTimestamp);
      });

      it('timestamp in the past', async () => {
        const now = await time.latest();
        let newStartTimestamp = now - 1;
        await expect(plugin.setStartTimestamp(newStartTimestamp)).to.be.revertedWith('In past');
      });

      it('trading started', async () => {
        const now = await time.latest();
        const period = 1000;
        let newStartTimestamp = now + period;
        await plugin.setStartTimestamp(newStartTimestamp);
        await time.increaseTo(newStartTimestamp);
        newStartTimestamp += period;
        await expect(plugin.setStartTimestamp(newStartTimestamp)).to.be.revertedWith('Trading started');
      });
    });
    describe('#setAuxFeeData', () => {
      const configuration = {
        feeReceiver: TEST_FEE_RECEIVER,
        period: 3600,
        startingFee: 550_000,
        disabledPriorStart: false,
      };

      const MAX_FEE = 900_000;
      const MIN_SNIPE_PERIOD = 5 * 60;
      const MAX_SNIPE_PERIOD = 86400;

      it('updates auxFeeData', async () => {
        await plugin.setAuxFeeData(configuration);

        const [startTimestamp, feeReceiver, period, startingFee, currentAuxFee, disabledPriorStart] = await plugin.feeConfig();

        expect(feeReceiver).to.eq(configuration.feeReceiver);
        expect(period).to.eq(configuration.period);
        expect(startingFee).to.eq(configuration.startingFee);
        expect(currentAuxFee).to.eq(configuration.startingFee);
        expect(disabledPriorStart).to.eq(configuration.disabledPriorStart);
        expect(startTimestamp).to.eq(0);
      });

      it('updates only fee receiver after trading starts', async () => {
        const now = await time.latest();
        let newStartTimestamp = now + 1000;
        await plugin.setStartTimestamp(newStartTimestamp);
        await time.increaseTo(newStartTimestamp);

        const [, _feeReceiver, _period, _startingFee, , _disabledPriorStart] = await plugin.feeConfig();

        const config2 = JSON.parse(JSON.stringify(configuration));

        config2.feeReceiver = wallet.address;
        config2.period = 0;
        config2.startingFee = 0;
        config2.disabledPriorStart = false;
        await plugin.setAuxFeeData(config2);

        const [startTimestamp, feeReceiver, period, startingFee, , disabledPriorStart] = await plugin.feeConfig();

        expect(feeReceiver).to.eq(config2.feeReceiver);
        expect(period).to.eq(_period);
        expect(startingFee).to.eq(_startingFee);
        expect(disabledPriorStart).to.eq(_disabledPriorStart);
        expect(startTimestamp).to.eq(newStartTimestamp);
      });

      it('emits event', async () => {
        await expect(plugin.setAuxFeeData(configuration))
          .to.emit(plugin, 'AuxFee')
          .withArgs([configuration.feeReceiver, configuration.period, configuration.startingFee, configuration.disabledPriorStart]);
      });

      it('cannot set feeReceiver as zero address', async () => {
        const conf2 = { ...configuration };
        conf2.feeReceiver = ZeroAddress;
        await expect(plugin.setAuxFeeData(conf2)).to.be.reverted;
      });

      it('cannot exceed feeReceiver as zero address', async () => {
        const conf2 = { ...configuration };
        conf2.feeReceiver = ZeroAddress;
        await expect(plugin.setAuxFeeData(conf2)).to.be.reverted;
      });

      it('cannot exceed max starting fee', async () => {
        const conf2 = { ...configuration };
        conf2.startingFee = MAX_FEE + 1;
        await expect(plugin.setAuxFeeData(conf2)).to.be.reverted;
      });

      it('invalid period', async () => {
        const conf2 = { ...configuration };
        conf2.period = MIN_SNIPE_PERIOD - 1;
        await expect(plugin.setAuxFeeData(conf2)).to.be.reverted;

        conf2.period = MAX_SNIPE_PERIOD + 1;
        await expect(plugin.setAuxFeeData(conf2)).to.be.reverted;
      });
    });
  });
});
