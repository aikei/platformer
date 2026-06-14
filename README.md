# Platformer

## Development

```sh
npm install
npm run dev
```

## Multiplayer relay

The client uses `VITE_RELAY_URL` to find the relay. The default is set in `.env`:

```sh
VITE_RELAY_URL=wss://aikeii.com:8080
```

The relay server listens on TCP port `8080` by default and can be started manually without TLS with:

```sh
npm start
```

For TLS, set `TLS_CERT_FILE` and `TLS_KEY_FILE` before starting the relay.

```sh
TLS_CERT_FILE=/etc/platformer-relay/fullchain.pem TLS_KEY_FILE=/etc/platformer-relay/privkey.pem npm start
```

For production, run it with systemd so it starts on boot and restarts after failures:

```sh
sudo cp deploy/platformer-relay.service /etc/systemd/system/platformer-relay.service
sudo systemctl daemon-reload
sudo systemctl enable --now platformer-relay
sudo systemctl status platformer-relay
```

Open the relay port in the firewall:

```sh
sudo ufw allow 8080/tcp
sudo ufw status
```
