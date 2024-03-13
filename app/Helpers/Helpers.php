<?php

namespace App\Helpers;

use Exception;

class Helpers {
    public static function isJson(string $string): bool {
        try {
            json_decode($string);

            return (json_last_error() == JSON_ERROR_NONE);
        } catch (Exception) {
        }

        return false;
    }
}
