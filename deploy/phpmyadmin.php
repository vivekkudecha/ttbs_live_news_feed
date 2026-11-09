<?php
// phpMyAdmin hardening (dev/uat only). deploy.sh passes this file to the container as
// PMA_USER_CONFIG_BASE64, so it works regardless of host file permissions.
$cfg['Servers'][1]['AllowRoot'] = false;        // MySQL root cannot sign in
$cfg['Servers'][1]['AllowNoPassword'] = false;
$cfg['ShowServerInfo'] = false;
$cfg['ShowPhpInfo'] = false;
$cfg['ShowCreateDb'] = false;
$cfg['ShowGitRevision'] = false;
$cfg['VersionCheck'] = false;
$cfg['SendErrorReports'] = 'never';
$cfg['LoginCookieValidity'] = 1800;              // 30 minutes
$cfg['LoginCookieDeleteAll'] = true;
