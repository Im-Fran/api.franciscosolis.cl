<?php

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

class JsonPrettyPrintMiddleware {

    public function handle(Request $request, Closure $next) {
        $response = $next($request);
        if($response instanceof JsonResponse && ($request->has('pretty') || !app()->isProduction())) {
            $response->setEncodingOptions(JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        }

        return $response;
    }
}
