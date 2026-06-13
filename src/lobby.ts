// Lobby: pick a mode and establish a connection before the game starts.
//
// Returns a result that main.ts uses to launch the game. Game state sync is NOT
// done here — the lobby only gets players into a shared room and to the 'start'
// signal. The game protocol is built on top of net later.

import { Net } from './net';

export type LobbyResult =
  | { mode: 'solo' | 'local2' }
  | { mode: 'host' | 'guest'; net: Net };

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export function runLobby(): Promise<LobbyResult> {
  const lobby = $('lobby');
  const menu = $('menu');
  const hostView = $('host-view');
  const joinView = $('join-view');
  const errorEl = $('lobby-error');

  const showView = (view: 'menu' | 'host' | 'join') => {
    menu.hidden = view !== 'menu';
    hostView.hidden = view !== 'host';
    joinView.hidden = view !== 'join';
    errorEl.textContent = '';
  };

  return new Promise<LobbyResult>((resolve) => {
    const finish = (result: LobbyResult) => {
      lobby.hidden = true;
      resolve(result);
    };

    // --- single player / two on one PC ---
    $('btn-solo').onclick = () => finish({ mode: 'solo' });
    $('btn-local2').onclick = () => finish({ mode: 'local2' });

    // --- host ---
    $('btn-host').onclick = async () => {
      showView('host');
      const net = new Net();
      const status = $('host-status');
      const startBtn = $<HTMLButtonElement>('btn-start');

      net.onPeerJoined = () => {
        status.textContent = `players nearby: ${net.peers.size} — ready to start`;
        startBtn.disabled = false;
      };
      net.onPeerLeft = () => {
        status.textContent = net.peers.size
          ? `players nearby: ${net.peers.size}`
          : 'waiting for players…';
        startBtn.disabled = net.peers.size === 0;
      };

      try {
        const code = await net.host();
        $('code').textContent = code;
        status.textContent = 'waiting for players…';
      } catch (e) {
        errorEl.textContent = (e as Error).message;
        showView('menu');
        return;
      }

      startBtn.onclick = () => {
        net.send('all', { kind: 'start' }); // tell guests the game has started
        finish({ mode: 'host', net });
      };
    };

    // --- guest ---
    $('btn-join').onclick = () => {
      showView('join');
      const input = $<HTMLInputElement>('code-input');
      const status = $('join-status');
      input.value = '';
      input.focus();

      $('btn-connect').onclick = async () => {
        const code = input.value.trim();
        if (code.length !== 4) {
          errorEl.textContent = 'the code is 4 characters';
          return;
        }
        const net = new Net();
        status.textContent = 'connecting…';

        // the guest waits for the 'start' signal from the host
        net.onMessage = (_from, data) => {
          if (data?.kind === 'start') finish({ mode: 'guest', net });
        };
        net.onHostLeft = () => {
          errorEl.textContent = 'the host closed the room';
          showView('menu');
        };

        try {
          await net.join(code);
          status.textContent = "you're in the room — waiting for the host to start…";
        } catch (e) {
          errorEl.textContent = (e as Error).message;
          status.textContent = '';
        }
      };
    };

    // 'back' buttons
    for (const back of document.querySelectorAll<HTMLButtonElement>('#lobby .back')) {
      back.onclick = () => showView('menu');
    }
  });
}
