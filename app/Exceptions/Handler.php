<?php

namespace App\Exceptions;

use Illuminate\Foundation\Exceptions\Handler as ExceptionHandler;
use Illuminate\Http\Request;
use Illuminate\Support\ViewErrorBag;
use Symfony\Component\HttpKernel\Exception\HttpExceptionInterface;
use Throwable;

class Handler extends ExceptionHandler {
    /**
     * The list of the inputs that are never flashed to the session on validation exceptions.
     *
     * @var array<int, string>
     */
    protected $dontFlash = [
        'current_password',
        'password',
        'password_confirmation',
    ];

    private array $titles = [
        400 => 'We can\'t process your request',
        401 => 'Authentication is required',
        403 => 'You are not authorized',
        404 => 'We can\'t find that page',
        405 => 'That method is not allowed',
        419 => 'Your session has expired',
        500 => 'We are experiencing technical difficulties',
        503 => "We're experiencing some difficulties",
        503.1 => "We're under maintenance",
    ];

    private array $errorMessages = [
        400 => 'Sorry but it looks like you made a mistake. Please try again.',
        401 => 'Sorry but it looks like you are not authorized to view this page.',
        403 => 'Sorry but it looks like you need more permissions to view this page.',
        404 => 'Sorry but it looks like you are looking for something that does not exist.',
        405 => 'Sorry but it looks like you are not authorized to view this page.',
        419 => 'Sorry but it looks like your session has expired. Please try again.',
        500 => 'Sorry but it looks like something went wrong on our end. Please try again.',
        503 => 'Sorry but it looks like we\'re experiencing some difficulties. Please try again later.',
        503.1 => 'Sorry but it looks like we\'re under maintenance. Please try again later.',
    ];

    /**
     * Register the exception handling callbacks for the application.
     */
    public function register(): void {
        $this->reportable(function(Throwable $e) {
        });

        $this->renderable(function(HttpExceptionInterface $e, Request $request) {
            $code = app()->isDownForMaintenance() ? 503.1 : $e->getStatusCode();
            $headers = $request->headers;
            $headers->add($e->getHeaders());

            return response()->json([
                'errors' => new ViewErrorBag(),
                'exception' => $e,
                'data' => [
                    'host' => gethostname(),
                    'timestamp' => now()->format('m/d/Y H:i:s'),
                    'code' => intval($code),
                    'message' => app()->isProduction() ? $this->errorMessages[$code] : $e->getMessage(),
                    'title' => $this->titles[$code] ?? 'We can\'t figure out what went wrong. Please try again later.',
                ],
            ], intval($code));
        });
    }
}
