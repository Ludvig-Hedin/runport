FROM clickhouse/clickhouse-server:26.4.3-alpine
COPY appwrite.xml /etc/clickhouse-server/config.d/appwrite.xml
COPY init.sh /docker-entrypoint-initdb.d/clickhouse-init.sh
