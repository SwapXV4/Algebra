import { MaxUint256, parseEther, Wallet, ZeroAddress } from 'ethers';
import { ethers } from 'hardhat';
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from './shared/expect';
import { TEST_FEE_RECEIVER, TEST_POOL_START_TIME, antiSniperPluginFixture } from './shared/fixtures';
import { PLUGIN_FLAGS, encodePriceSqrt, expandTo18Decimals, getMaxTick, getMinTick } from './shared/utilities';

import { MockPool, MockTimeAntiSniper, MockTimeAntiSniperFactory, MockTimeVirtualPool, TestERC20 } from '../typechain';

import BigNumber from 'bignumber.js';
import checkTimepointEquals from './shared/checkTimepointEquals';
import snapshotGasCost from './shared/snapshotGasCost';

describe('AntiSniper', () => {
  let wallet: Wallet, other: Wallet;

  let plugin: MockTimeAntiSniper; // modified plugin
  let mockPool: MockPool; // mock of AlgebraPool
  let mockPluginFactory: MockTimeAntiSniperFactory; // modified plugin factory

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

    const [, , periodSetup] = await plugin.auxFeeConfig();
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

      await expect(plugin.initialize()).to.be.revertedWith('Already initialized');
    });

    it('cannot construct twice', async () => {
      await expect(plugin.construct(ZeroAddress, ZeroAddress, ZeroAddress)).to.be.revertedWith('Constructed');
    });

    it('cannot initialize detached plugin', async () => {
      await initializeAtZeroTick(mockPool);
      await expect(plugin.initialize()).to.be.revertedWith('Plugin not attached');
    });

    it('cannot initialize if pool not initialized', async () => {
      await mockPool.setPlugin(plugin);
      await expect(plugin.initialize()).to.be.revertedWith('Pool is not initialized');
    });

    it('can initialize for existing pool', async () => {
      await initializeAtZeroTick(mockPool);
      await mockPool.setPlugin(plugin);
      await plugin.initialize();

      const timepoint = await plugin.timepoints(0);
      expect(timepoint.initialized).to.be.true;
    });

    it('can not write to uninitialized oracle', async () => {
      await initializeAtZeroTick(mockPool);
      await mockPool.setPlugin(plugin);
      await mockPool.setPluginConfig(1); // BEFORE_SWAP_FLAG

      await expect(mockPool['swapToTick(int24)'](5)).to.be.revertedWith('Not initialized');
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

        const [, , , , _currentAuxFee] = await plugin.auxFeeConfig();
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
        expect((await mockPool.globalState()).pluginConfig).to.be.eq(defaultConfig);
      });
      it('charges starting fee when trading prior start is enabled', async () => {
        const now = await time.latest();
        const period = 1000;
        let newStartTimestamp = now + period;
        await plugin.setStartTimestamp(newStartTimestamp);

        const [, _feeReceiver, _period, _startingFee] = await plugin.auxFeeConfig();
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

        const [, _feeReceiver, _period, _startingFee] = await plugin.auxFeeConfig();
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

        const [, _feeReceiver, _period, _startingFee] = await plugin.auxFeeConfig();
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

        const [, _feeReceiver, _period, _startingFee] = await plugin.auxFeeConfig();
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

  describe('#VolatilityVolatilityOracle', () => {
    beforeEach('connect plugin to pool', async () => {
      await skipAuxFee();
      await mockPool.setPlugin(plugin);
    });

    it('initializes timepoints slot', async () => {
      await initializeAtZeroTick(mockPool);
      checkTimepointEquals(await plugin.timepoints(0), {
        initialized: true,
        blockTimestamp: BigInt(TEST_POOL_START_TIME),
        tickCumulative: 0n,
      });
    });

    describe('#getTimepoints', () => {
      beforeEach(async () => await initializeAtZeroTick(mockPool));

      // zero tick
      it('current tick accumulator increases by tick over time', async () => {
        let {
          tickCumulatives: [tickCumulative],
        } = await plugin.getTimepoints([0]);
        expect(tickCumulative).to.eq(0);
        await plugin.advanceTime(10);
        ({
          tickCumulatives: [tickCumulative],
        } = await plugin.getTimepoints([0]));
        expect(tickCumulative).to.eq(0);
      });

      it('current tick accumulator after single swap', async () => {
        // moves to tick -1
        await mockPool['swapToTick(int24)'](-1);

        await plugin.advanceTime(4);
        let {
          tickCumulatives: [tickCumulative],
        } = await plugin.getTimepoints([0]);
        expect(tickCumulative).to.eq(-4);
      });

      it('current tick accumulator after swaps', async () => {
        await mockPool['swapToTick(int24)'](-4463);
        expect((await mockPool.globalState()).tick).to.eq(-4463);
        await plugin.advanceTime(4);
        await mockPool['swapToTick(int24)'](-1560);
        expect((await mockPool.globalState()).tick).to.eq(-1560);
        let {
          tickCumulatives: [tickCumulative0],
        } = await plugin.getTimepoints([0]);
        expect(tickCumulative0).to.eq(-17852);
        await plugin.advanceTime(60 * 5);
        await mockPool['swapToTick(int24)'](-1561);
        let {
          tickCumulatives: [tickCumulative1],
        } = await plugin.getTimepoints([0]);
        expect(tickCumulative1).to.eq(-485852);
      });
    });

    it('writes an timepoint', async () => {
      await initializeAtZeroTick(mockPool);
      checkTimepointEquals(await plugin.timepoints(0), {
        tickCumulative: 0n,
        blockTimestamp: BigInt(TEST_POOL_START_TIME),
        initialized: true,
      });
      await plugin.advanceTime(1);
      await mockPool['swapToTick(int24)'](10);
      checkTimepointEquals(await plugin.timepoints(1), {
        tickCumulative: 0n,
        blockTimestamp: BigInt(TEST_POOL_START_TIME + 1),
        initialized: true,
      });
    });

    it('does not write an timepoint', async () => {
      await initializeAtZeroTick(mockPool);
      checkTimepointEquals(await plugin.timepoints(0), {
        tickCumulative: 0n,
        blockTimestamp: BigInt(TEST_POOL_START_TIME),
        initialized: true,
      });
      await plugin.advanceTime(1);
      await mockPool.mint(wallet.address, wallet.address, -240, 0, 100, '0x');
      checkTimepointEquals(await plugin.timepoints(0), {
        tickCumulative: 0n,
        blockTimestamp: BigInt(TEST_POOL_START_TIME),
        initialized: true,
      });
    });

    describe('#getSingleTimepoint', () => {
      beforeEach(async () => await initializeAtZeroTick(mockPool));

      // zero tick
      it('current tick accumulator increases by tick over time', async () => {
        let { tickCumulative } = await plugin.getSingleTimepoint(0);
        expect(tickCumulative).to.eq(0);
        await plugin.advanceTime(10);
        ({ tickCumulative } = await plugin.getSingleTimepoint(0));
        expect(tickCumulative).to.eq(0);
      });

      it('current tick accumulator after single swap', async () => {
        // moves to tick -1
        await mockPool['swapToTick(int24)'](-1);
        await plugin.advanceTime(4);
        let { tickCumulative } = await plugin.getSingleTimepoint(0);
        expect(tickCumulative).to.eq(-4);
      });

      it('current tick accumulator after swaps', async () => {
        await mockPool['swapToTick(int24)'](-4463);
        expect((await mockPool.globalState()).tick).to.eq(-4463);
        await plugin.advanceTime(4);
        await mockPool['swapToTick(int24)'](-1560);
        expect((await mockPool.globalState()).tick).to.eq(-1560);
        let { tickCumulative: tickCumulative0 } = await plugin.getSingleTimepoint(0);
        expect(tickCumulative0).to.eq(-17852);
        await plugin.advanceTime(60 * 5);
        await mockPool['swapToTick(int24)'](-1561);
        let { tickCumulative: tickCumulative1 } = await plugin.getSingleTimepoint(0);
        expect(tickCumulative1).to.eq(-485852);
      });
    });

    describe('#prepayTimepointsStorageSlots', () => {
      it('can prepay', async () => {
        await plugin.prepayTimepointsStorageSlots(0, 50);
      });

      it('can prepay with space', async () => {
        await plugin.prepayTimepointsStorageSlots(10, 50);
      });

      it('writes after swap, prepaid after init', async () => {
        await initializeAtZeroTick(mockPool);
        await plugin.prepayTimepointsStorageSlots(1, 1);
        expect((await plugin.timepoints(1)).blockTimestamp).to.be.eq(1);
        await mockPool['swapToTick(int24)'](-4463);
        expect((await mockPool.globalState()).tick).to.eq(-4463);
        await plugin.advanceTime(4);
        await mockPool['swapToTick(int24)'](-1560);
        expect((await plugin.timepoints(1)).blockTimestamp).to.be.not.eq(1);
        expect((await mockPool.globalState()).tick).to.eq(-1560);
        let { tickCumulative: tickCumulative0 } = await plugin.getSingleTimepoint(0);
        expect(tickCumulative0).to.eq(-17852);
      });

      it('writes after swap, prepaid before init', async () => {
        await plugin.prepayTimepointsStorageSlots(0, 2);
        await initializeAtZeroTick(mockPool);
        expect((await plugin.timepoints(1)).blockTimestamp).to.be.eq(1);
        await mockPool['swapToTick(int24)'](-4463);
        expect((await mockPool.globalState()).tick).to.eq(-4463);
        await plugin.advanceTime(4);
        await mockPool['swapToTick(int24)'](-1560);
        expect((await plugin.timepoints(1)).blockTimestamp).to.be.not.eq(1);
        expect((await mockPool.globalState()).tick).to.eq(-1560);
        let { tickCumulative: tickCumulative0 } = await plugin.getSingleTimepoint(0);
        expect(tickCumulative0).to.eq(-17852);
      });

      describe('failure cases', async () => {
        it('cannot rewrite initialized slot', async () => {
          await initializeAtZeroTick(mockPool);
          await expect(plugin.prepayTimepointsStorageSlots(0, 2)).to.be.reverted;
          await plugin.advanceTime(4);
          await mockPool['swapToTick(int24)'](-1560);
          await expect(plugin.prepayTimepointsStorageSlots(1, 2)).to.be.reverted;
          await expect(plugin.prepayTimepointsStorageSlots(2, 2)).to.be.not.reverted;
        });

        it('cannot prepay 0 slots', async () => {
          await expect(plugin.prepayTimepointsStorageSlots(0, 0)).to.be.revertedWithoutReason;
        });

        it('cannot overflow index', async () => {
          await plugin.prepayTimepointsStorageSlots(0, 10);
          expect(plugin.prepayTimepointsStorageSlots(11, 2n ** 16n - 5n)).to.be.revertedWithoutReason;
          expect(plugin.prepayTimepointsStorageSlots(11, 2n ** 16n)).to.be.revertedWithoutReason;
        });
      });
    });
  });

  describe('#DynamicFeeManager', () => {
    describe('#adaptiveFee', function () {
      this.timeout(0);
      const liquidity = expandTo18Decimals(1000);
      const DAY = 60 * 60 * 24;
      const INITIAL_MIN_FEE = 0.01e4; // 0.01%
      let mint: any;

      beforeEach('initialize pool', async () => {
        await mockPool.setPlugin(plugin);
        await skipAuxFee();
        await initializeAtZeroTick(mockPool);
        // await plugin.changeFeeConfiguration({
        //   alpha1: 3000 - INITIAL_MIN_FEE,
        //   alpha2: 15000 - 3000,
        //   beta1: 1001,
        //   beta2: 1006,
        //   gamma1: 20,
        //   gamma2: 22,
        //   baseFee: INITIAL_MIN_FEE,
        // });
        mint = async (recipient: string, tickLower: number, tickUpper: number, liquidityDesired: number) => {
          await mockPool.mint(recipient, recipient, tickLower, tickUpper, liquidityDesired, '0x');
        };
      });

      it('does not change at 0 volume', async () => {
        await plugin.advanceTime(1);
        await mockPool.mint(wallet.address, wallet.address, -6000, 6000, liquidity, '0x');
        let fee2 = (await mockPool.globalState()).fee;
        await plugin.advanceTime(DAY + 600);
        await mint(wallet.address, -6000, 6000, 1);
        let fee3 = (await mockPool.globalState()).fee;
        expect(fee3).to.be.equal(fee2);
      });

      it('does not change fee after first swap in block', async () => {
        await mockPool.mint(wallet.address, wallet.address, -6000, 6000, liquidity, '0x');
        await plugin.advanceTime(DAY + 600);
        await mockPool['swapToTick(int24)'](100);
        let feeInit = (await mockPool.globalState()).fee;
        await mockPool['swapToTick(int24)'](100000);
        await mockPool['swapToTick(int24)'](100001);
        let feeAfter = (await mockPool.globalState()).fee;
        expect(feeAfter).to.be.equal(feeInit);
      });

      it('does not change if alphas are zeroes', async () => {
        await plugin.changeFeeConfiguration({
          alpha1: 0,
          alpha2: 0,
          beta1: 360,
          beta2: 60000,
          gamma1: 59,
          gamma2: 8500,
          baseFee: 10000,
        });
        await mockPool.mint(wallet.address, wallet.address, -6000, 6000, liquidity, '0x');
        let feeInit = (await mockPool.globalState()).fee;
        await plugin.advanceTime(DAY + 600);
        await mockPool['swapToTick(int24)'](100000);
        await plugin.advanceTime(DAY + 600);
        await mockPool['swapToTick(int24)'](-100000);
        let feeFinal = (await mockPool.globalState()).fee;
        expect(feeFinal).to.be.equal(feeInit);
      });

      it('single huge step after day', async () => {
        await mint(wallet.address, -24000, 24000, liquidity * 1000000000n);

        await plugin.advanceTime(DAY);
        await mockPool['swapToTick(int24)'](10);
        await plugin.advanceTime(60);
        await mockPool['swapToTick(int24)'](-10000);
        await plugin.advanceTime(60);
        await mockPool['swapToTick(int24)'](10);

        let stats = [];
        const tick = 10;
        for (let i = 0; i < 25; i++) {
          await mockPool['swapToTick(int24)'](tick - i);
          let fee = (await mockPool.globalState()).fee;
          stats.push(`Fee: ${fee} `);
          await plugin.advanceTime(60 * 60);
        }
        expect(stats).to.matchSnapshot('fee stats after step');
      });

      it('single huge step after initialization', async () => {
        await mint(wallet.address, -24000, 24000, liquidity * 1000000000n);

        await plugin.advanceTime(60);
        await mockPool['swapToTick(int24)'](10);
        await plugin.advanceTime(60);
        await mockPool['swapToTick(int24)'](-10000);
        await plugin.advanceTime(60);
        await mockPool['swapToTick(int24)'](10);

        let stats = [];
        const tick = 10;
        for (let i = 0; i < 25; i++) {
          await mockPool['swapToTick(int24)'](tick - i);
          let fee = (await mockPool.globalState()).fee;
          stats.push(`Fee: ${fee} `);
          await plugin.advanceTime(60 * 60);
        }
        expect(stats).to.matchSnapshot('fee stats after step');
      });

      it('single huge spike after day', async () => {
        await mint(wallet.address, -24000, 24000, liquidity * 1000000000n);
        await plugin.advanceTime(DAY);
        await plugin.advanceTime(60);
        await mockPool['swapToTick(int24)'](-10000);
        await plugin.advanceTime(1);
        await mockPool['swapToTick(int24)'](0);
        await plugin.advanceTime(60);
        await mockPool['swapToTick(int24)'](10);

        let stats = [];
        const tick = 10;
        for (let i = 0; i < 25; i++) {
          await mockPool['swapToTick(int24)'](tick - i);

          let fee = (await mockPool.globalState()).fee;
          stats.push(`Fee: ${fee} `);
          await plugin.advanceTime(60 * 60);
        }
        expect(stats).to.matchSnapshot('fee stats after spike');
      });

      it('single huge spike after initialization', async () => {
        await mint(wallet.address, -24000, 24000, liquidity * 1000000000n);

        await plugin.advanceTime(60);
        await mockPool['swapToTick(int24)'](10);
        await plugin.advanceTime(60);
        await mockPool['swapToTick(int24)'](-10000);
        await plugin.advanceTime(1);
        await mockPool['swapToTick(int24)'](-11);
        await plugin.advanceTime(60);
        await mockPool['swapToTick(int24)'](0);

        let stats = [];
        const tick = 0;
        for (let i = 0; i < 25; i++) {
          await mockPool['swapToTick(int24)'](tick - i);
          let fee = (await mockPool.globalState()).fee;
          stats.push(`Fee: ${fee} `);
          await plugin.advanceTime(60 * 60);
        }
        expect(stats).to.matchSnapshot('fee stats after spike');
      });

      describe('#getCurrentFee', async () => {
        it('works with dynamic fee', async () => {
          await plugin.advanceTime(60);
          await mockPool['swapToTick(int24)'](10);
          await plugin.advanceTime(60);
          await mockPool['swapToTick(int24)'](10);
          const currentFee = await plugin.getCurrentFee();
          expect(currentFee).to.be.eq(10000);
        });

        it('works if alphas are zeroes', async () => {
          await plugin.changeFeeConfiguration({
            alpha1: 0,
            alpha2: 0,
            beta1: 1001,
            beta2: 1006,
            gamma1: 20,
            gamma2: 22,
            baseFee: 100,
          });
          await plugin.advanceTime(60);
          await mockPool['swapToTick(int24)'](10);
          await plugin.advanceTime(60);
          await mockPool['swapToTick(int24)'](10);
          const currentFee = await plugin.getCurrentFee();
          expect(currentFee).to.be.eq(100);
        });

        it('works equal before and after timepoint write', async () => {
          await plugin.changeFeeConfiguration({
            alpha1: 3000 - INITIAL_MIN_FEE,
            alpha2: 15000 - 3000,
            beta1: 360,
            beta2: 60000,
            gamma1: 59,
            gamma2: 8500,
            baseFee: 10000,
          });
          await plugin.advanceTime(60);
          await mockPool['swapToTick(int24)'](100);
          await plugin.advanceTime(60 * 10);
          await mockPool['swapToTick(int24)'](1000);
          await plugin.advanceTime(60 * 10);
          const currentFee = await plugin.getCurrentFee();
          await mockPool['swapToTick(int24)'](-1000);
          const currentFeeAfterSwap = await plugin.getCurrentFee();
          expect(currentFeeAfterSwap).to.be.eq(currentFee);
          await plugin.advanceTime(1);
          const currentFee2 = await plugin.getCurrentFee();
          expect(currentFeeAfterSwap).to.be.not.eq(currentFee2);
        });
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
        let [startTimestamp] = await plugin.auxFeeConfig();
        expect(startTimestamp).to.eq(newStartTimestamp);

        await time.increaseTo(now + period - 2);
        newStartTimestamp = newStartTimestamp + period;
        await plugin.setStartTimestamp(newStartTimestamp);
        [startTimestamp] = await plugin.auxFeeConfig();
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

        const [startTimestamp, feeReceiver, period, startingFee, currentAuxFee, disabledPriorStart] = await plugin.auxFeeConfig();

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

        const [, _feeReceiver, _period, _startingFee, , _disabledPriorStart] = await plugin.auxFeeConfig();

        const config2 = JSON.parse(JSON.stringify(configuration));

        config2.feeReceiver = wallet.address;
        config2.period = 0;
        config2.startingFee = 0;
        config2.disabledPriorStart = false;
        await plugin.setAuxFeeData(config2);

        const [startTimestamp, feeReceiver, period, startingFee, , disabledPriorStart] = await plugin.auxFeeConfig();

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
    describe('#changeFeeConfiguration', () => {
      beforeEach('prep init', async () => {
        await mockPool.setPlugin(plugin);
        await initializeAtZeroTick(mockPool);
      });

      const configuration = {
        alpha1: 3002,
        alpha2: 10009,
        beta1: 1001,
        beta2: 1006,
        gamma1: 20,
        gamma2: 22,
        baseFee: 150,
      };
      it('fails if caller is not factory', async () => {
        await expect(plugin.connect(other).changeFeeConfiguration(configuration)).to.be.reverted;
      });

      it('updates baseFeeConfiguration', async () => {
        await plugin.changeFeeConfiguration(configuration);

        const newConfig = await plugin.feeConfig();

        expect(newConfig.alpha1).to.eq(configuration.alpha1);
        expect(newConfig.alpha2).to.eq(configuration.alpha2);
        expect(newConfig.beta1).to.eq(configuration.beta1);
        expect(newConfig.beta2).to.eq(configuration.beta2);
        expect(newConfig.gamma1).to.eq(configuration.gamma1);
        expect(newConfig.gamma2).to.eq(configuration.gamma2);
        expect(newConfig.baseFee).to.eq(configuration.baseFee);
      });

      it('feeConfig getter gas cost [ @skip-on-coverage ]', async () => {
        await plugin.changeFeeConfiguration(configuration);
        await snapshotGasCost(plugin.feeConfig.estimateGas());
      });

      it('emits event', async () => {
        await expect(plugin.changeFeeConfiguration(configuration))
          .to.emit(plugin, 'FeeConfiguration')
          .withArgs([...Object.values(configuration)]);
      });

      it('cannot exceed max fee', async () => {
        let wrongConfig = { ...configuration };
        wrongConfig.alpha1 = 30000;
        wrongConfig.alpha2 = 30000;
        wrongConfig.baseFee = 15000;
        await expect(plugin.changeFeeConfiguration(wrongConfig)).to.be.revertedWith('Max fee exceeded');
      });

      it('cannot set zero gamma', async () => {
        let wrongConfig1 = { ...configuration };
        wrongConfig1.gamma1 = 0;
        await expect(plugin.changeFeeConfiguration(wrongConfig1)).to.be.revertedWith('Gammas must be > 0');

        let wrongConfig2 = { ...configuration };
        wrongConfig2.gamma2 = 0;
        await expect(plugin.changeFeeConfiguration(wrongConfig2)).to.be.revertedWith('Gammas must be > 0');
      });
    });
  });
});
