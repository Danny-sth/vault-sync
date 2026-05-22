FROM eclipse-temurin:21-jre-alpine

WORKDIR /app

# Create non-root user
RUN addgroup -g 1000 vaultsync && \
    adduser -u 1000 -G vaultsync -s /bin/sh -D vaultsync

# Copy JAR file
COPY target/*.jar app.jar

# Create data directory
RUN mkdir -p /data && chown -R vaultsync:vaultsync /data

USER vaultsync

EXPOSE 8443

ENV VAULT_SYNC_STORAGE_PATH=/data
ENV VAULT_SYNC_TOKEN=""
ENV SPRING_PROFILES_ACTIVE=docker

ENTRYPOINT ["java", "-jar", "app.jar"]
