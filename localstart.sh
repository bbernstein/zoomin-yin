# change these if you need to listen to a different port or specific server address
export LISTEN_PORT=1235

# change these if Isadora is on a different machine or listening to a different port
export ZOOMOSC_HOST=127.0.0.1
export ZOOMOSC_PORT=9090

if [ ! -d 'node_modules' ]; then
  npm install
fi

npm start
