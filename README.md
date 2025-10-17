# cs356

To run the code, first run `npm install` then `node cli.js`. To change set values, go to `config.js`.

## Docker

Build the image:

```bash
docker build -t cs356-app .
```

Run the container (interactive CLI):

```bash
docker run --rm -it -v "$(pwd)":/usr/src/app -w /usr/src/app cs356-app
```

Or using docker-compose:

```bash
docker-compose up --build
```

Notes:

- `phantom_deps.json` and `phantom.txt` are ignored in the image by default to avoid baking data into the image. Use a bind mount (the examples above) to access and persist data on the host.
- If you want the container to seed from `phantom.txt` on startup, change the container command to `node seed_from_phantom_txt.js`.
