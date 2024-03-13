<?php

namespace App\Http\Middleware\Networking;

use Closure;
use Illuminate\Http\Request;

class CloudflareConnectingIpMiddleware {
    public function handle(Request $request, Closure $next) {
        if ($request->hasHeader('cf-connecting-ip')) {
            $_SERVER['REMOTE_ADDR'] = $request->header('cf-connecting-ip');
        }

        return $next($request);
    }
}
