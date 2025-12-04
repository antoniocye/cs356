# Phantom Dependencies: Ghost Busting
# Large Scale Study of Phantom Dependencies in npm and PyPi


To run the code, first install necessary dependencies by running
```bash
npm install
```

Then, run `cd database_manager_npm`, build the docker image in case you want to do any depcheck queries using:

```bash
docker build --no-cache -f docker/Depcheck.Dockerfile -t depcheck-runner:latest .
```

And finally, modify `database.js` to call whatever functions you need before running:
```bash
node database.js
```

You can run the previous cli script by running `cd archived_files` then `node cli.js` from the root directory.