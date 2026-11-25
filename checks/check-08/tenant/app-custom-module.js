// A tenant that adds its own wallet module, which the kit allows. The module's display name is
// shaped like a Stellar address and its error message holds a hash-shaped string, so the test
// can show that neither reaches an event.
import { StellarWalletsKit } from '@creit.tech/stellar-wallets-kit/sdk';
import { defaultModules } from '@creit.tech/stellar-wallets-kit/modules/utils';
import { ModuleType } from '@creit.tech/stellar-wallets-kit/types';

export const CUSTOM_WALLET_NAME = 'GCUSTOMWALLETNAMESHAPEDLIKEANADDRESSAAAAAAAAAAAAAAAAAAAAAA';
export const CUSTOM_WALLET_ERROR = `tx ${'ab12'.repeat(16)} failed`;

const customModule = {
  moduleType: ModuleType.HOT_WALLET,
  productId: 'tenant-custom',
  productName: CUSTOM_WALLET_NAME,
  productUrl: 'http://localhost/',
  productIcon: '',
  isAvailable: async () => true,
  getAddress: async () => {
    throw { code: -1, message: CUSTOM_WALLET_ERROR };
  },
};

StellarWalletsKit.init({ modules: [...defaultModules(), customModule] });

document.querySelector('#connect').addEventListener('click', async () => {
  try {
    await StellarWalletsKit.authModal();
  } catch (error) {
    document.querySelector('#error').textContent = `${error.code}: ${error.message}`;
  }
});
