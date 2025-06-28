import { Wallet, ZeroAddress } from 'ethers';
import { ethers } from 'hardhat';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from './shared/expect';
import { TEST_FEE_RECEIVER, ZERO_ADDRESS, antiSniperPluginFactoryFixture } from './shared/fixtures';

import { MockFactory, AntiSniperPluginFactory, AlgebraAntiSniperPluginV1 } from '../typechain';

describe('AntiSniperPluginFactory', () => {
  let wallet: Wallet, other: Wallet;

  let pluginFactory: AntiSniperPluginFactory;
  let mockAlgebraFactory: MockFactory;

  before('prepare signers', async () => {
    [wallet, other] = await (ethers as any).getSigners();
  });

  beforeEach('deploy test volatilityOracle', async () => {
    ({ pluginFactory, mockFactory: mockAlgebraFactory } = await loadFixture(antiSniperPluginFactoryFixture));
  });

  describe('#Create plugin', () => {
    it('only factory', async () => {
      expect(pluginFactory.createPlugin(wallet.address, ZERO_ADDRESS, ZERO_ADDRESS)).to.be.revertedWithoutReason;
    });

    it('factory can create plugin', async () => {
      const pluginFactoryFactory = await ethers.getContractFactory('AntiSniperPluginFactory');
      const pluginFactoryMock = (await pluginFactoryFactory.deploy(wallet.address, TEST_FEE_RECEIVER)) as any as AntiSniperPluginFactory;

      const pluginAddress = await pluginFactoryMock.createPlugin.staticCall(wallet.address, ZERO_ADDRESS, ZERO_ADDRESS);
      await pluginFactoryMock.createPlugin(wallet.address, ZERO_ADDRESS, ZERO_ADDRESS);

      const pluginMock = (await ethers.getContractFactory('AlgebraAntiSniperPluginV1')).attach(pluginAddress) as any as AlgebraAntiSniperPluginV1;
      const feeConfig = await pluginMock.feeConfig();
      expect(feeConfig.startTimestamp_).to.be.eq(0);
    });
  });

  describe('#CreatePluginForExistingPool', () => {
    it('only if has role', async () => {
      expect(pluginFactory.connect(other).createPluginForExistingPool(wallet.address, other.address)).to.be.revertedWithoutReason;
    });

    it('cannot create for nonexistent pool', async () => {
      await expect(pluginFactory.createPluginForExistingPool(wallet.address, other.address)).to.be.revertedWith('Pool not exist');
    });

    it('can create for existing pool', async () => {
      await mockAlgebraFactory.stubPool(wallet.address, other.address, other.address);

      await pluginFactory.createPluginForExistingPool(wallet.address, other.address);
      const pluginAddress = await pluginFactory.pluginByPool(other.address);
      expect(pluginAddress).to.not.be.eq(ZERO_ADDRESS);
      const pluginMock = (await ethers.getContractFactory('AlgebraAntiSniperPluginV1')).attach(pluginAddress) as any as AlgebraAntiSniperPluginV1;
      const feeConfig = await pluginMock.feeConfig();
      expect(feeConfig.startTimestamp_).to.be.eq(0);
    });

    it('cannot create twice for existing pool', async () => {
      await mockAlgebraFactory.stubPool(wallet.address, other.address, other.address);

      await pluginFactory.createPluginForExistingPool(wallet.address, other.address);

      await expect(pluginFactory.createPluginForExistingPool(wallet.address, other.address)).to.be.revertedWith('Already created');
    });
  });

  describe('#Default aux fee configuration', () => {
    describe('#setDefaultAuxFeeData', () => {
      const configuration = {
        feeReceiver: TEST_FEE_RECEIVER,
        period: 3600,
        startingFee: 550_000,
        disabledPriorStart: false,
      };

      const MAX_FEE = 900_000;
      const MIN_SNIPE_PERIOD = 5 * 60;
      const MAX_SNIPE_PERIOD = 86400;

      it('fails if caller is not owner', async () => {
        await expect(pluginFactory.connect(other).setDefaultAuxFeeData(configuration)).to.be.revertedWith('Only administrator');
      });

      it('updates defaultFeeConfiguration', async () => {
        await pluginFactory.setDefaultAuxFeeData(configuration);

        const newConfig = await pluginFactory.defaultAuxFeeData();

        expect(newConfig.feeReceiver).to.eq(configuration.feeReceiver);
        expect(newConfig.period).to.eq(configuration.period);
        expect(newConfig.startingFee).to.eq(configuration.startingFee);
        expect(newConfig.disabledPriorStart).to.eq(configuration.disabledPriorStart);
      });

      it('emits event', async () => {
        await expect(pluginFactory.setDefaultAuxFeeData(configuration))
          .to.emit(pluginFactory, 'AuxFee')
          .withArgs([configuration.feeReceiver, configuration.period, configuration.startingFee, configuration.disabledPriorStart]);
      });

      it('cannot set feeReceiver as zero address', async () => {
        const conf2 = { ...configuration };
        conf2.feeReceiver = ZeroAddress;
        await expect(pluginFactory.setDefaultAuxFeeData(conf2)).to.be.reverted;
      });

      it('cannot exceed feeReceiver as zero address', async () => {
        const conf2 = { ...configuration };
        conf2.feeReceiver = ZeroAddress;
        await expect(pluginFactory.setDefaultAuxFeeData(conf2)).to.be.reverted;
      });

      it('cannot exceed max starting fee', async () => {
        const conf2 = { ...configuration };
        conf2.startingFee = MAX_FEE + 1;
        await expect(pluginFactory.setDefaultAuxFeeData(conf2)).to.be.reverted;
      });

      it('invalid period', async () => {
        const conf2 = { ...configuration };
        conf2.period = MIN_SNIPE_PERIOD - 1;
        await expect(pluginFactory.setDefaultAuxFeeData(conf2)).to.be.reverted;

        conf2.period = MAX_SNIPE_PERIOD + 1;
        await expect(pluginFactory.setDefaultAuxFeeData(conf2)).to.be.reverted;
      });
    });
  });

  describe('#setFarmingAddress', () => {
    it('fails if caller is not owner', async () => {
      await expect(pluginFactory.connect(other).setFarmingAddress(wallet.address)).to.be.revertedWith('Only administrator');
    });

    it('updates farmingAddress', async () => {
      await pluginFactory.setFarmingAddress(other.address);
      expect(await pluginFactory.farmingAddress()).to.eq(other.address);
    });

    it('emits event', async () => {
      await expect(pluginFactory.setFarmingAddress(other.address)).to.emit(pluginFactory, 'FarmingAddress').withArgs(other.address);
    });

    it('cannot set current address', async () => {
      await pluginFactory.setFarmingAddress(other.address);
      await expect(pluginFactory.setFarmingAddress(other.address)).to.be.reverted;
    });
  });
});
