<?php

use App\Http\Middleware\Content\HandleLocaleMiddleware;
use App\Http\Middleware\Content\JsonFormatter;
use App\Http\Middleware\Content\JsonPrettyPrint;
use App\Http\Middleware\EnsureEmailIsVerified;
use App\Http\Middleware\Networking\CloudflareConnectingIpMiddleware;
use Illuminate\Foundation\Application;
use Illuminate\Foundation\Configuration\Exceptions;
use Illuminate\Foundation\Configuration\Middleware;
use Sentry\Laravel\Integration;

return Application::configure(basePath: dirname(__DIR__))
    ->withRouting(
        web: __DIR__.'/../routes/web.php',
        commands: __DIR__.'/../routes/console.php',
    )
    ->withMiddleware(function (Middleware $middleware) {
        $middleware->use([
            HandleLocaleMiddleware::class,
            JsonFormatter::class,
            JsonPrettyPrint::class,
            CloudflareConnectingIpMiddleware::class,
        ]);

        $middleware->priority([
            CloudflareConnectingIpMiddleware::class,
            HandleLocaleMiddleware::class,
            JsonFormatter::class,
            JsonPrettyPrint::class,
        ]);

        $middleware->alias([
            'verified' => EnsureEmailIsVerified::class,
        ]);
    })
    ->withExceptions(function (Exceptions $exceptions) {
        Integration::handles($exceptions);
        $exceptions->render(function(Throwable $e){
            if($e instanceof \Symfony\Component\HttpKernel\Exception\HttpException) {
                $statusCode = $e->getStatusCode();
                $headers = $e->getHeaders();
            }

            return response()->json([
                'status' => 'error',
                'error' => [
                    'message' => $e->getMessage(),
                    'trace' => app()->isProduction() ? 'Available through Issue Tracker.' : $e->getTrace(),
                ]
            ], $statusCode ?? 500, $headers ?? []);
        });
    })
    ->create();
