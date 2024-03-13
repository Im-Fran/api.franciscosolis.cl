<?php

namespace App\Http\Middleware\Content;

use Closure;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

class JsonPrettyPrint {
    /**
     * Handle an incoming request.
     *
     * @param Closure(Request): (Response) $next
     */
    public function handle(Request $request, Closure $next): Response {
        $response = $next($request);
        if ($response instanceof JsonResponse && $request->has('prettyJson')) {
            $response = $response->setEncodingOptions(JSON_PRETTY_PRINT);
        }

        return $response;
    }
}
