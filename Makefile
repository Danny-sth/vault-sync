.PHONY: all server plugin clean

all: server plugin

server:
	cd server && go build -o ../bin/vault-sync .

plugin:
	cd plugin && npm install && npm run build

clean:
	rm -rf bin/
	rm -f plugin/main.js

# Development
dev-server:
	cd server && go run .

dev-plugin:
	cd plugin && npm run dev

# Deploy
deploy:
	scp bin/vault-sync root@90.156.230.49:/opt/vault-sync/
	ssh root@90.156.230.49 "sudo systemctl restart vault-sync"
