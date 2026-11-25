// The tenant's code. It uses Stellar Wallets Kit as its guide shows and holds no analytics code.
import { StellarWalletsKit } from '@creit.tech/stellar-wallets-kit/sdk';
import { defaultModules } from '@creit.tech/stellar-wallets-kit/modules/utils';
import { KitEventType } from '@creit.tech/stellar-wallets-kit/types';

StellarWalletsKit.init({ modules: defaultModules() });
StellarWalletsKit.createButton(document.querySelector('#kit-button'));

StellarWalletsKit.on(KitEventType.STATE_UPDATED, (event) => {
  document.querySelector('#account').textContent = event.payload.address ?? 'none';
  if (event.payload.address) document.title = `Account ${event.payload.address}`;
});

document.querySelector('#connect').addEventListener('click', async () => {
  try {
    await StellarWalletsKit.authModal();
  } catch (error) {
    document.querySelector('#error').textContent = `${error.code}: ${error.message}`;
  }
});
