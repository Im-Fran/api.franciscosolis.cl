<?php

namespace App\Helpers;

class Helper {
    public static function repeat(int $times, callable $callback): void {
        foreach (range(0, $times) as $_) {
            $callback();
        }
    }
}
