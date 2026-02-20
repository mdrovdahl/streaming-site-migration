<?php
/**
 * Admin interface for Site Export plugin.
 *
 * This plugin provides a WordPress admin UI for configuring the export API.
 * The shared secret is stored in a WordPress option so it travels with
 * backups/migrations and does not rely on plugin directory write access.
 *
 * Authentication uses HMAC signatures: the importing side generates a secret,
 * the user enters it here, and all requests must include a valid signature
 * computed from: shared_secret + nonce + timestamp.
 */
class Site_Export_Plugin {

    private static $instance = null;

    public static function get_instance() {
        if (self::$instance === null) {
            self::$instance = new self();
        }
        return self::$instance;
    }

    private function __construct() {
        add_action('admin_menu', [$this, 'add_admin_menu']);
        add_action('admin_init', [$this, 'handle_settings_save']);
        add_filter('plugin_action_links_' . plugin_basename(SITE_EXPORT_PLUGIN_DIR . 'index.php'), [$this, 'add_settings_link']);
    }

    /**
     * Add "Settings" link to the plugin row on the Plugins page.
     */
    public function add_settings_link(array $links): array {
        $url = admin_url('tools.php?page=site-export');
        array_unshift($links, '<a href="' . esc_url($url) . '">Settings</a>');
        return $links;
    }

    /**
     * Add submenu page under Tools.
     */
    public function add_admin_menu() {
        add_submenu_page(
            'tools.php',
            'Streaming Exporter',
            'Streaming Exporter',
            'manage_options',
            'site-export',
            [$this, 'render_admin_page']
        );
    }

    /**
     * Handle settings form submission.
     */
    public function handle_settings_save() {
        if (!isset($_POST['site_export_save_settings'])) {
            return;
        }

        if (!current_user_can('manage_options')) {
            return;
        }

        check_admin_referer('site_export_settings');

        $secret = isset($_POST['site_export_secret']) ? sanitize_text_field($_POST['site_export_secret']) : '';

        // Persist secret in WordPress options.
        $result = $this->save_secret($secret);

        if (is_wp_error($result)) {
            add_settings_error(
                'site_export',
                'save_failed',
                'Failed to save secret: ' . $result->get_error_message(),
                'error'
            );
        } else {
            add_settings_error(
                'site_export',
                'save_success',
                'Settings saved successfully.',
                'success'
            );
        }
    }

    /**
     * Save the secret to WordPress options.
     *
     * @param string $secret The shared secret
     * @return true|WP_Error
     */
    private function save_secret(string $secret) {
        $result = update_option(SITE_EXPORT_SECRET_OPTION, $secret, false);
        if ($result === false && get_option(SITE_EXPORT_SECRET_OPTION, null) !== $secret) {
            return new WP_Error(
                'update_failed',
                'Could not save secret to WordPress options.'
            );
        }

        return true;
    }

    /**
     * Load the current secret from options, with one-time migration from file.
     *
     * @return string
     */
    private function load_secret(): string {
        $secret = get_option(SITE_EXPORT_SECRET_OPTION, '');
        if (is_string($secret) && $secret !== '') {
            return $secret;
        }

        // Backward compatibility: migrate from legacy secret.php if present.
        if (file_exists(SITE_EXPORT_SECRET_FILE)) {
            $legacy = require SITE_EXPORT_SECRET_FILE;
            if (is_string($legacy) && $legacy !== '') {
                update_option(SITE_EXPORT_SECRET_OPTION, $legacy, false);
                return $legacy;
            }
        }

        return '';
    }

    /**
     * Render the admin page.
     */
    public function render_admin_page() {
        if (!current_user_can('manage_options')) {
            return;
        }

        $secret = $this->load_secret();
        $api_url = home_url('?site-export-api');
        $is_configured = !empty($secret);

        ?>
        <style>
            .site-export-wrap {
                max-width: 680px;
                margin: 40px auto 0;
                font-size: 14px;
            }
            .site-export-wrap h1 {
                font-size: 28px;
                font-weight: 600;
                margin-bottom: 4px;
            }
            .site-export-wrap .subtitle {
                color: #646970;
                font-size: 14px;
                margin: 0 0 30px;
            }
            .site-export-card {
                background: #fff;
                border: 1px solid #ddd;
                border-radius: 8px;
                padding: 28px 32px;
                margin-bottom: 24px;
            }
            .site-export-card h2 {
                font-size: 16px;
                font-weight: 600;
                margin: 0 0 6px;
                padding: 0;
            }
            .site-export-card .card-desc {
                color: #646970;
                margin: 0 0 20px;
            }
            .site-export-secret-field {
                display: flex;
                gap: 8px;
                align-items: start;
            }
            .site-export-secret-field input[type="password"],
            .site-export-secret-field input[type="text"] {
                flex: 1;
                font-family: monospace;
                font-size: 14px;
                padding: 8px 12px;
                border-radius: 4px;
            }
            .site-export-secret-field .button {
                flex-shrink: 0;
                height: 38px;
            }
            .site-export-toggle-btn {
                background: none;
                border: 1px solid #8c8f94;
                border-radius: 4px;
                cursor: pointer;
                padding: 6px 10px;
                color: #50575e;
                height: 38px;
                display: inline-flex;
                align-items: center;
            }
            .site-export-toggle-btn:hover {
                border-color: #2271b1;
                color: #2271b1;
            }
            .site-export-status {
                display: flex;
                align-items: center;
                gap: 10px;
                padding: 14px 18px;
                border-radius: 6px;
                margin-bottom: 20px;
                font-size: 14px;
            }
            .site-export-status.is-ready {
                background: #edfaef;
                border: 1px solid #b8e6be;
                color: #1e4620;
            }
            .site-export-status.is-pending {
                background: #fef8ee;
                border: 1px solid #f0d9a8;
                color: #6e4e00;
            }
            .site-export-status .dashicons {
                font-size: 20px;
                width: 20px;
                height: 20px;
            }
            .site-export-endpoint {
                background: #f6f7f7;
                border: 1px solid #ddd;
                border-radius: 6px;
                padding: 14px 18px;
                display: flex;
                align-items: center;
                gap: 10px;
            }
            .site-export-endpoint code {
                flex: 1;
                font-size: 13px;
                word-break: break-all;
                background: none;
                padding: 0;
            }
            .site-export-copy-btn {
                background: none;
                border: 1px solid #8c8f94;
                border-radius: 4px;
                cursor: pointer;
                padding: 4px 10px;
                color: #50575e;
                font-size: 12px;
                white-space: nowrap;
            }
            .site-export-copy-btn:hover {
                border-color: #2271b1;
                color: #2271b1;
            }
        </style>

        <div class="site-export-wrap">
            <h1>Site Export</h1>
            <p class="subtitle">Securely stream this site's database and files (optional) to an authorized WordPress Playground instance.</p>

            <?php settings_errors('site_export'); ?>

            <?php if ($is_configured): ?>
            <div class="site-export-status is-ready">
                <span class="dashicons dashicons-yes-alt"></span>
                <span><strong>Ready to export.</strong> The import tool can now connect to this site.</span>
            </div>
            <?php else: ?>
            <div class="site-export-status is-pending">
                <span class="dashicons dashicons-warning"></span>
                <span><strong>Waiting for connection.</strong> Open your import tool &mdash; it will give you a connection token to paste below.</span>
            </div>
            <?php endif; ?>

            <div class="site-export-card">
                <h2>Connection Token</h2>
                <p class="card-desc">
                    Copy the token from your import tool and paste it here. This authorizes the import tool to download your site's data.
                </p>

                <form method="post" action="">
                    <?php wp_nonce_field('site_export_settings'); ?>

                    <div class="site-export-secret-field">
                        <input type="password"
                               id="site_export_secret"
                               name="site_export_secret"
                               value="<?php echo esc_attr($secret); ?>"
                               placeholder="Paste connection token"
                               autocomplete="off" />
                        <button type="button" class="site-export-toggle-btn" onclick="siteExportToggleSecret()" title="Show / hide token">
                            <span class="dashicons dashicons-visibility"></span>
                        </button>
                        <input type="submit"
                               name="site_export_save_settings"
                               class="button button-primary"
                               value="Save" />
                    </div>
                </form>
            </div>

            <?php if ($is_configured): ?>
            <div class="site-export-card">
                <h2>API Endpoint</h2>
                <p class="card-desc">
                    Paste this URL into your import tool so it knows where to connect:
                </p>
                <div class="site-export-endpoint">
                    <code id="site-export-api-url"><?php echo esc_html($api_url); ?></code>
                    <button type="button" class="site-export-copy-btn" onclick="siteExportCopyUrl()">Copy</button>
                </div>
            </div>
            <?php endif; ?>
        </div>

        <script>
        function siteExportToggleSecret() {
            var input = document.getElementById('site_export_secret');
            input.type = input.type === 'password' ? 'text' : 'password';
        }
        function siteExportCopyUrl() {
            var url = document.getElementById('site-export-api-url').textContent.trim();
            navigator.clipboard.writeText(url).then(function() {
                var btn = document.querySelector('.site-export-copy-btn');
                var original = btn.textContent;
                btn.textContent = 'Copied!';
                setTimeout(function() { btn.textContent = original; }, 1500);
            });
        }
        </script>
        <?php
    }
}

// Initialize
add_action('plugins_loaded', function() {
    Site_Export_Plugin::get_instance();
});

// On activation: set a transient so we can redirect on the next admin page load.
register_activation_hook(SITE_EXPORT_PLUGIN_DIR . 'index.php', function() {
    // Only redirect when activated through the admin UI (not via WP-CLI or bulk).
    if (!wp_doing_ajax() && is_admin()) {
        set_transient('site_export_activated', 1, 30);
    }

});

// Redirect to settings page after activation or upgrade.
add_action('admin_init', function() {
    if (get_transient('site_export_activated')) {
        delete_transient('site_export_activated');
        if (!isset($_GET['activate-multi'])) {
            wp_safe_redirect(admin_url('tools.php?page=site-export'));
            exit;
        }
    }
});

// On upgrade: set the same transient so the next admin page load redirects to settings.
add_action('upgrader_process_complete', function($upgrader, $options) {
    if ($options['action'] !== 'update' || $options['type'] !== 'plugin') {
        return;
    }
    // Check if our plugin was in the update list
    $our_plugin = plugin_basename(SITE_EXPORT_PLUGIN_DIR . 'index.php');
    $plugins = isset($options['plugins']) ? $options['plugins'] : [];
    if (isset($options['plugin'])) {
        $plugins[] = $options['plugin'];
    }
    if (in_array($our_plugin, $plugins, true)) {
        set_transient('site_export_activated', 1, 30);
    }
}, 10, 2);
