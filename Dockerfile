FROM php:8.4-apache

ENV PORT=8080 APP_ENV=staging
RUN docker-php-ext-install pdo_mysql \
    && a2enmod rewrite headers \
    && a2dismod status autoindex \
    && a2disconf other-vhosts-access-log \
    && cp "$PHP_INI_DIR/php.ini-production" "$PHP_INI_DIR/php.ini" \
    && printf '%s\n' 'file_uploads=Off' 'display_errors=Off' 'log_errors=On' 'date.timezone=UTC' > "$PHP_INI_DIR/conf.d/slipstream.ini" \
    && printf '%s\n' 'Listen 0.0.0.0:${PORT}' > /etc/apache2/ports.conf

WORKDIR /opt/slipstream
COPY deploy/apache.conf /etc/apache2/sites-available/000-default.conf
COPY config/config.php config/
COPY api/db.php api/sessions.php api/
COPY database/schema.sql database/init.php database/
COPY index.html slipstream-favicon.svg public/
COPY css/style.css public/css/
COPY js/api.js js/app.js js/webrtc.js js/file-sender.js js/file-receiver.js public/js/
COPY js/vendor/qrcode.min.js public/js/vendor/

RUN apache2ctl configtest && php -r 'exit(in_array("mysql", PDO::getAvailableDrivers(), true) ? 0 : 1);'
EXPOSE 8080
CMD ["apache2-foreground"]
