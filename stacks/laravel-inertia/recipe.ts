import type { StackRecipe } from "@caddie/contracts";

/**
 * laravel-inertia stack recipe. PHP/Composer required in the sandbox;
 * destructive migrations run only against the disposable test database.
 * Live verification (composer install, migrate, serve, browser proof)
 * is BLOCKED on the P09 live window + Laravel toolchain availability.
 */
export const recipe: StackRecipe = {
	id: "laravel-inertia",
	version: "1.0.0",
	imageDigest: "sha256:TEMPLATE-FROZEN-AT-P15B",
	install: ["composer install --no-interaction", "npm install"],
	test: ["php artisan test"],
	build: ["npm run build"],
	start: ["php artisan serve --port=8080"],
	requiredCapabilities: ["php", "composer", "node"],
	artifacts: ["public/build/", "storage/logs/"],
	preview: "server",
	availability: "unverified",
};
